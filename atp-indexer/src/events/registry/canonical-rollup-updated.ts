import { ponder } from "ponder:registry";
import { and, eq, or, isNull, notInArray, sql } from "drizzle-orm";
import {
  rollupVersion,
  deposit,
  staked,
  stakedWithProvider,
  erc20StakedWithProvider,
  withdrawInitiated,
  withdrawFinalized,
} from "ponder:schema";
import { normalizeAddress } from "../../utils/address";

/**
 * Handle CanonicalRollupUpdated event from the Aztec Registry.
 *
 * Every canonical rollup upgrade goes through Registry.addRollup(), which
 * emits this event. Two things happen here:
 *
 * 1. Record the new version row in `rollupVersion` so /api/rollups can
 *    expose current + history without the frontend or API handlers making
 *    their own Registry RPC calls. Uses `onConflictDoNothing` to keep the
 *    handler crash-safe: the raw SQL bulk update further down isn't
 *    tracked by Ponder's snapshot, so on a crash mid-handler the indexer
 *    will retry the event; the conflict guard prevents a duplicate-key
 *    abort on the retry's `rollupVersion` insert.
 *
 * 2. Migrate `effectiveRollup` for every stake-shaped row that *might* be
 *    auto-migrating. Two cases:
 *
 *      - `moveWithRollup = true` (explicit) — the dashboard's deposit
 *        flow defaults to true, and the protocol auto-migrates these.
 *      - `moveWithRollup = null` (decoder couldn't recover the flag) —
 *        captures rows deposited via wrappers our calldata decoder
 *        doesn't unwrap (Safe.execTransaction, MultiSend, router
 *        contracts, etc.). The pragmatic call is to *presume* migrating
 *        and let the dashboard's on-chain probe correct on the rare
 *        case where the user actually deposited with `false`. The cost
 *        of a wrong-hint is one extra RPC read; the cost of NOT
 *        migrating is Safe users never seeing the fast path.
 *
 *    `moveWithRollup = false` (explicit) is excluded. Those stakes stay
 *    pinned to their deposit-time rollup.
 *
 *    Reorg note: this is the only handler that issues raw SQL writes
 *    (`db.sql.update`) which Ponder's snapshot mechanism doesn't track.
 *    On a reorg of the block containing this event, the `rollupVersion`
 *    insert IS rolled back (snapshot-tracked) but the bulk update is
 *    NOT. The system self-heals on the next CanonicalRollupUpdated for
 *    the post-reorg canonical: that event's bulk update sets
 *    `effectiveRollup` to whatever IS canonical now. Until then,
 *    `effectiveRollup` may point at the reorg-discarded canonical — a
 *    stale hint, not a wrong write, since the dashboard's on-chain
 *    probe always overrides on disagreement. Per-row `db.update` would
 *    be reorg-safe but is O(N rows) per event; we accept the brief
 *    stale window in exchange for the bulk performance.
 *
 *    Exiting attesters (latest withdraw event is an initiate, not a
 *    finalize) are EXCLUDED from the bulk update. The protocol locks
 *    the exit to the rollup where `initiateWithdraw` was called — the
 *    stake does NOT migrate when canonical rotates, even with
 *    `moveWithRollup = true`. Rewriting `effectiveRollup` for an
 *    exiting attester strands the dashboard: if the exit happened on a
 *    rollup that's neither deposit-time nor the new canonical (e.g.
 *    deposit on A, auto-migrated to B, initiated on B, then B→C
 *    canonical shift), the dashboard's probe has no remaining
 *    candidate that holds the live record and the finalize button
 *    targets the wrong rollup. Comparing latest `withdrawInitiated` vs
 *    latest `withdrawFinalized` timestamps correctly excludes the
 *    full lifecycle: initiate → finalize → re-deposit → re-initiate is
 *    captured as exiting (newer initiate); a finalized-and-not-re-
 *    initiated validator is NOT pinned, so their row migrates with
 *    canonical normally.
 *
 *    ZOMBIE / slashed-below-threshold attesters are NOT excluded.
 *    There's no indexer-side signal that distinguishes
 *    "slashed-into-zombie" from "slashed-but-still-VALIDATING" without
 *    re-running the threshold math on every Slashed event, and the
 *    rollup contract migrates ZOMBIE registrations alongside
 *    VALIDATING ones (the live record moves; only an active exit
 *    pins). For the rare cascading case (ZOMBIE on B, then B→C with
 *    deposit-time = A), the dashboard's chain probe still corrects:
 *    legacy = A → NONE, canonical = C → NONE, hint = C (was B before
 *    bulk update) — yes, this remains a gap for ZOMBIEs in deeply
 *    cascading migrations. Accept this until we observe it in
 *    practice; the fix would be probing the prior `effectiveRollup`
 *    value, which requires schema history we don't yet keep.
 */
ponder.on("Registry:CanonicalRollupUpdated", async ({ event, context }) => {
  const { instance, version } = event.args;
  const { db } = context;
  const newCanonical = normalizeAddress(instance) as `0x${string}`;

  await db
    .insert(rollupVersion)
    .values({
      version,
      address: newCanonical,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();

  // WHERE moveWithRollup = true OR moveWithRollup IS NULL  →  matches
  // explicit-true and unknown rows, excludes explicit-false. The column
  // is 3-valued (true/false/null); these two predicates partition the
  // "should migrate" set unambiguously.
  const isMaybeMigrating = (table: { moveWithRollup: unknown }) =>
    or(
      eq(table.moveWithRollup as Parameters<typeof eq>[0], true),
      isNull(table.moveWithRollup as Parameters<typeof isNull>[0]),
    );

  // Find attesters CURRENTLY mid-exit (latest withdrawInitiated has no
  // later withdrawFinalized). The exit is locked to the rollup where
  // initiate-withdraw was called, so these rows must NOT have their
  // `effectiveRollup` rewritten.
  //
  // Aggregate in SQL: one row per attester per event type. Without
  // GROUP BY we'd be scanning the full event-history tables on every
  // canonical event — fine today, painful on a long-running chain.
  //
  // Note: we only iterate `latestInitiate` and look up against
  // `latestFinalize`. A finalize-only attester (no preceding initiate)
  // is impossible by protocol — the contract requires an initiate
  // before finalize — so the asymmetry doesn't drop any real exiting
  // rows.
  //
  // Lifecycle handled: initiate → finalize → re-deposit → re-initiate
  // appears as exiting (newer initiate ts > newer finalize ts). A
  // finalized-and-not-re-initiated validator does NOT appear, so their
  // row migrates with canonical rotations.
  const [latestInitiate, latestFinalize] = await Promise.all([
    db.sql
      .select({
        attesterAddress: withdrawInitiated.attesterAddress,
        maxTimestamp: sql<bigint>`MAX(${withdrawInitiated.timestamp})`.as("max_ts"),
      })
      .from(withdrawInitiated)
      .groupBy(withdrawInitiated.attesterAddress),
    db.sql
      .select({
        attesterAddress: withdrawFinalized.attesterAddress,
        maxTimestamp: sql<bigint>`MAX(${withdrawFinalized.timestamp})`.as("max_ts"),
      })
      .from(withdrawFinalized)
      .groupBy(withdrawFinalized.attesterAddress),
  ]);
  const latestFinalizeByAttester = new Map<string, bigint>();
  for (const r of latestFinalize) {
    latestFinalizeByAttester.set(r.attesterAddress, r.maxTimestamp);
  }
  const exitingAttesters: `0x${string}`[] = [];
  for (const r of latestInitiate) {
    const finalizeTs = latestFinalizeByAttester.get(r.attesterAddress);
    if (finalizeTs === undefined || r.maxTimestamp > finalizeTs) {
      exitingAttesters.push(r.attesterAddress as `0x${string}`);
    }
  }

  const isNotExiting = (table: { attesterAddress: unknown }) =>
    notInArray(
      table.attesterAddress as Parameters<typeof notInArray>[0],
      exitingAttesters,
    );

  const tablesToMigrate = [
    { table: deposit, label: "deposit" },
    { table: staked, label: "staked" },
    { table: stakedWithProvider, label: "stakedWithProvider" },
    { table: erc20StakedWithProvider, label: "erc20StakedWithProvider" },
  ] as const;

  let totalUpdated = 0;
  for (const { table, label } of tablesToMigrate) {
    try {
      const result = await db.sql
        .update(table)
        .set({ effectiveRollup: newCanonical })
        .where(and(isMaybeMigrating(table), isNotExiting(table)));
      const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? null;
      if (rowCount !== null) {
        totalUpdated += rowCount;
        console.log(`  effectiveRollup migration: ${label} updated ${rowCount} rows`);
      }
    } catch (err) {
      console.error(`  effectiveRollup migration failed for ${label}:`, err);
      // Re-throw so the indexer retries this event rather than leaving
      // half-migrated state. The raw SQL update is idempotent: re-running
      // it against rows already pointing at `newCanonical` is a no-op.
      throw err;
    }
  }

  console.log(
    `Canonical rollup updated: version ${version}, instance ${instance}, effectiveRollup-migrated rows: ${totalUpdated || "(driver did not report count)"}`,
  );
});
