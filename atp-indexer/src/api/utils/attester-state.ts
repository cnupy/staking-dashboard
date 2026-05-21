import { sql } from "drizzle-orm";
import {
  deposit,
  slashed,
  withdrawInitiated,
  withdrawFinalized,
} from "ponder:schema";

/**
 * Per-attester runtime classification, derived from indexer event tables
 * + chain-supplied thresholds. The dashboard and indexer APIs use this
 * to keep TVL / per-provider totals honest in the face of slashing,
 * exits, and re-deposits.
 *
 * - ACTIVE: registered and able to validate (effective balance ≥ ejection threshold,
 *   no in-flight exit, no clean exit since last deposit).
 * - EXITING: latest `withdrawInitiated` is newer than latest `withdrawFinalized`.
 *   Exit locks the stake to the rollup where the initiate fired, so the
 *   protocol won't reclassify them mid-exit even if they get slashed.
 * - ZOMBIE: effective balance < ejection threshold; still registered, no
 *   longer validating.
 * - EXITED: latest `withdrawFinalized` is newer than the latest `deposit`.
 *   The attester finalized and has not re-deposited since.
 * - NOT_REGISTERED: address has never been seen in the `deposit` event
 *   table. Returned when a caller asks about an address that was never
 *   a sequencer (e.g., a typo'd `providerSelfStake` entry, or an
 *   address that only exists off-chain).
 *
 * EXITING wins over ZOMBIE if both apply, matching the protocol's
 * priority (an attester in the middle of exiting can't be moved into
 * zombie state).
 */
export type AttesterStatus = "ACTIVE" | "EXITING" | "ZOMBIE" | "EXITED" | "NOT_REGISTERED";

export interface AttesterState {
  status: AttesterStatus;
  /**
   * activationThreshold − sum(slashed amounts), clamped to 0. EXITED
   * and NOT_REGISTERED always return 0 here — even if the math would
   * otherwise yield a positive number — because tokens have left the
   * contract (EXITED) or were never there (NOT_REGISTERED). Callers
   * summing TVL can rely on `effectiveBalance` alone without needing
   * to also filter by status.
   *
   * Approximation: rewards may add to on-chain balance but we don't
   * track them here — actual effective balance can be slightly higher.
   * Used for "active TVL" math where we'd rather understate than
   * overstate.
   */
  effectiveBalance: bigint;
  /** Sum of all Slashed events for this attester. 0 if never slashed. */
  totalSlashed: bigint;
}

/**
 * Inputs to {@link classifyAttesterStatus}. Kept separate from the
 * lookup factory so `summary.ts` (which already has every map
 * materialised in-process) can share the exact same classification
 * logic without re-running the lookup-builder DB scans.
 */
export interface ClassifierInputs {
  /** Whether this attester appears in the `deposit` table at all. */
  hasDeposit: boolean;
  /** Latest `deposit` timestamp for this attester. `undefined` if no deposit. */
  latestDeposit: bigint | undefined;
  /** Latest `withdrawInitiated` timestamp. */
  latestInitiate: bigint | undefined;
  /** Latest `withdrawFinalized` timestamp. */
  latestFinalize: bigint | undefined;
  /** Sum of all slashed amounts for this attester. */
  totalSlashed: bigint;
  /**
   * `activationThreshold − ejectionThreshold` — the slash amount at
   * which an attester crosses into ZOMBIE. 0n disables zombie
   * classification (e.g., when the ejection-threshold RPC failed).
   */
  zombieSlashCutoff: bigint;
}

/**
 * Pure classifier — given the per-attester aggregates, return the
 * status. Shared between `buildAttesterStateLookup` (request-scoped
 * lookup table) and `summary.ts`'s inline loop (which only needs to
 * apportion slashes by status, not query every attester). Keeping
 * this in one place means fixes to status priority can't drift.
 */
export function classifyAttesterStatus(inputs: ClassifierInputs): AttesterStatus {
  if (!inputs.hasDeposit) return "NOT_REGISTERED";

  const { latestDeposit, latestInitiate, latestFinalize, totalSlashed, zombieSlashCutoff } = inputs;

  // EXITING: there's an open initiate (newer than the most recent
  // finalize, or no finalize at all). Wins over ZOMBIE because the
  // protocol pins the exit even if the attester would otherwise
  // classify as zombie. Note we compare against `latestFinalize` —
  // NOT `latestDeposit` — because an attester can re-initiate during
  // a re-deposited lifecycle.
  if (latestInitiate !== undefined && (latestFinalize === undefined || latestInitiate > latestFinalize)) {
    return "EXITING";
  }

  // EXITED: the latest finalize is *strictly* newer than any deposit.
  // The attester finalized cleanly and hasn't re-deposited since.
  // If they re-deposit after a clean exit (latestDeposit > latestFinalize),
  // we fall through to ACTIVE/ZOMBIE — they're a productive validator
  // again. Same-timestamp ties (finalize and deposit in the same block,
  // common during a re-deposit that immediately re-enters the queue)
  // resolve to ACTIVE rather than EXITED — re-deposit wins, since
  // classifying a freshly-restaked attester as EXITED would zero out
  // their effective balance.
  if (latestFinalize !== undefined && latestDeposit !== undefined && latestFinalize > latestDeposit) {
    return "EXITED";
  }

  // ZOMBIE: not exiting/exited, but slashed below the ejection
  // threshold. zombieSlashCutoff is 0n in the defensive case where the
  // ejection-threshold RPC failed; in that case no one is classified
  // ZOMBIE and the dashboard's chain probe handles individual stakes.
  if (zombieSlashCutoff > 0n && totalSlashed >= zombieSlashCutoff) {
    return "ZOMBIE";
  }

  return "ACTIVE";
}

interface BuildInputs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  activationThreshold: bigint;
  ejectionThreshold: bigint;
}

/**
 * Pre-aggregates the deposit / slashed / withdrawInitiated /
 * withdrawFinalized tables per attester (one SQL `GROUP BY` per table)
 * and returns a helper bound over those maps. Call it once per request;
 * reuse the helper across every attester lookup.
 *
 * The returned helper handles attesters with NO slashes / exits cleanly
 * (returns ACTIVE with full effectiveBalance), and addresses never seen
 * in `deposit` (returns NOT_REGISTERED with zero balance) — callers
 * don't need to short-circuit themselves.
 */
export async function buildAttesterStateLookup({
  db,
  activationThreshold,
  ejectionThreshold,
}: BuildInputs): Promise<(attesterAddress: string) => AttesterState> {
  const [depositAggregates, latestInitiates, latestFinalizes, slashSums] = await Promise.all([
    // Both the "ever deposited" set and the per-attester latest deposit
    // timestamp come from one query — we need the timestamp to detect
    // re-deposit-after-finalize cases (which must classify as ACTIVE,
    // not EXITED).
    db
      .select({
        attesterAddress: deposit.attesterAddress,
        maxTimestamp: sql<bigint>`MAX(${deposit.timestamp})`.as("max_deposit_ts"),
      })
      .from(deposit)
      .groupBy(deposit.attesterAddress),
    db
      .select({
        attesterAddress: withdrawInitiated.attesterAddress,
        maxTimestamp: sql<bigint>`MAX(${withdrawInitiated.timestamp})`.as("max_ts"),
      })
      .from(withdrawInitiated)
      .groupBy(withdrawInitiated.attesterAddress),
    db
      .select({
        attesterAddress: withdrawFinalized.attesterAddress,
        maxTimestamp: sql<bigint>`MAX(${withdrawFinalized.timestamp})`.as("max_ts"),
      })
      .from(withdrawFinalized)
      .groupBy(withdrawFinalized.attesterAddress),
    db
      .select({
        attesterAddress: slashed.attesterAddress,
        totalAmount: sql<bigint>`SUM(${slashed.amount})`.as("total_slashed"),
      })
      .from(slashed)
      .groupBy(slashed.attesterAddress),
  ]);

  const depositMap = new Map<string, bigint>();
  for (const r of depositAggregates) {
    depositMap.set(r.attesterAddress, r.maxTimestamp);
  }
  const initiateMap = new Map<string, bigint>();
  for (const r of latestInitiates) {
    initiateMap.set(r.attesterAddress, r.maxTimestamp);
  }
  const finalizeMap = new Map<string, bigint>();
  for (const r of latestFinalizes) {
    finalizeMap.set(r.attesterAddress, r.maxTimestamp);
  }
  const slashMap = new Map<string, bigint>();
  for (const r of slashSums) {
    slashMap.set(r.attesterAddress, r.totalAmount);
  }

  const zombieSlashCutoff = activationThreshold > ejectionThreshold
    ? activationThreshold - ejectionThreshold
    : 0n;

  return function lookup(attesterAddress: string): AttesterState {
    const totalSlashed = slashMap.get(attesterAddress) ?? 0n;
    const latestDeposit = depositMap.get(attesterAddress);
    const latestInitiate = initiateMap.get(attesterAddress);
    const latestFinalize = finalizeMap.get(attesterAddress);

    const status = classifyAttesterStatus({
      hasDeposit: latestDeposit !== undefined,
      latestDeposit,
      latestInitiate,
      latestFinalize,
      totalSlashed,
      zombieSlashCutoff,
    });

    // EXITED and NOT_REGISTERED return 0 effective balance — tokens
    // have left the contract or were never there. Saves every caller
    // from needing to filter by status before summing.
    if (status === "EXITED" || status === "NOT_REGISTERED") {
      return { status, effectiveBalance: 0n, totalSlashed };
    }

    const effectiveBalance = activationThreshold > totalSlashed
      ? activationThreshold - totalSlashed
      : 0n;

    return { status, effectiveBalance, totalSlashed };
  };
}
