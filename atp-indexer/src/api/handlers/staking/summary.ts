import type { Context } from 'hono';
import { db } from 'ponder:api';
import { count, eq, sql } from 'drizzle-orm';
import { getActivationThreshold, getLocalEjectionThreshold, calculateAPR, getActiveAttesterCount } from '../../../utils/rollup';
import { getCanonicalRollupAddress } from '../../utils/canonical-rollup';
import { getPublicClient } from '../../../utils/viem-client';
import { classifyAttesterStatus } from '../../utils/attester-state';
import { normalizeAddress } from '../../../utils/address';
import type { StakingSummaryResponse } from '../../types/staking.types';
import {
  stakedWithProvider,
  erc20StakedWithProvider,
  staked,
  failedDeposit,
  provider,
  atpPosition,
  slashed,
  withdrawInitiated,
  withdrawFinalized,
  deposit
} from 'ponder:schema';

/**
 * Handle GET /api/staking/summary
 * Get overall staking network statistics
 */
export async function handleStakingSummary(c: Context): Promise<Response> {
  try {
    const client = getPublicClient();
    const rollupAddress = await getCanonicalRollupAddress(client);

    // Data model explanation:
    // - `deposit` table: ALL Rollup:Deposit events (validator registrations on-chain)
    //   This includes BOTH provider delegations AND direct deposits, for both ATP and ERC20 flows.
    // - `stakedWithProvider`: ATP-based provider delegations (tracks source of stake)
    // - `erc20StakedWithProvider`: ERC20-based provider delegations (tracks source of stake)
    // - `staked`: ATP-based direct stakes (tracks source of stake)
    // - ERC20-based direct deposits: Only in `deposit` table (no separate tracking table yet)
    //
    // The `deposit` table is the source of truth for total validator registrations,
    // while other tables help categorize the source (ATP vs ERC20, direct vs provider).
    const [
      activationThreshold,
      ejectionThreshold,
      delegationsCountResult,       // ATP provider delegations
      erc20DelegationsCountResult,  // ERC20 provider delegations
      directStakesCountResult,      // ATP direct stakes
      failedDepositsLengthResult,
      withdrawnCountResult,
      uniqueProvidersCountResult,
      totalATPsResult,
      totalDepositsCountResult,     // ALL deposits (source of truth for total stakes)
      currentAPR,
      // Per-attester latest event timestamps. Used to compute the
      // EXITING bucket (latest initiate vs latest finalize) and — for
      // the slashed-attester apportionment loop below — to classify
      // each slashed attester via the shared `classifyAttesterStatus`
      // helper.
      latestDepositsByAttester,
      latestInitiatesByAttester,
      latestFinalizesByAttester,
      // Per-attester slash totals. Used to deduct slashed amounts from
      // headline TVL (so the dashboard reflects what's actually still in
      // the contract) and to classify zombies (slashed-below-ejection).
      slashSumsByAttester,
      // Authoritative active count from chain. `getActiveAttesterCount`
      // returns the VALIDATING set on the canonical rollup — excludes
      // ZOMBIE and EXITING by protocol design.
      activeAttesterCount
    ] = await Promise.all([
      getActivationThreshold(rollupAddress, client),
      getLocalEjectionThreshold(rollupAddress, client),
      db.select({ count: count() }).from(stakedWithProvider),
      db.select({ count: count() }).from(erc20StakedWithProvider),
      db.select({ count: count() }).from(staked),
      db.select({ count: count() }).from(failedDeposit),
      db.select({ count: count() }).from(withdrawFinalized),
      db.select({ count: count() }).from(provider),
      db.select({ count: count() }).from(atpPosition),
      db.select({ count: count() }).from(deposit),
      calculateAPR(rollupAddress, client),
      db
        .select({
          attesterAddress: deposit.attesterAddress,
          maxTimestamp: sql<bigint>`MAX(${deposit.timestamp})`.as('max_deposit_ts'),
        })
        .from(deposit)
        .groupBy(deposit.attesterAddress),
      db
        .select({
          attesterAddress: withdrawInitiated.attesterAddress,
          maxTimestamp: sql<bigint>`MAX(${withdrawInitiated.timestamp})`.as('max_ts'),
        })
        .from(withdrawInitiated)
        .groupBy(withdrawInitiated.attesterAddress),
      db
        .select({
          attesterAddress: withdrawFinalized.attesterAddress,
          maxTimestamp: sql<bigint>`MAX(${withdrawFinalized.timestamp})`.as('max_ts'),
        })
        .from(withdrawFinalized)
        .groupBy(withdrawFinalized.attesterAddress),
      db
        .select({
          attesterAddress: slashed.attesterAddress,
          totalAmount: sql<bigint>`SUM(${slashed.amount})`.as('total_slashed'),
        })
        .from(slashed)
        // Canonical-rollup only. Each rollup tracks its own
        // `effectiveBalance` (per `GSE.effectiveBalanceOf(instance, attester)`),
        // and the protocol's `StakingLib.slash` caps emission via
        // `Math.min(_amount, effectiveBalance)`. So per-attester
        // per-rollup slashes are bounded by activation. But aggregating
        // across rollups historically (e.g., attester slashed on legacy
        // A then on canonical B after `moveWithLatestRollup` migration)
        // sums multiple separate deductions and can exceed activation —
        // the empirical green-deploy TVL=0 was exactly this. For
        // canonical TVL we only care about slashes that happened on
        // the rollup whose `effectiveBalance` we're trying to reflect.
        .where(eq(slashed.rollupAddress, normalizeAddress(rollupAddress) as `0x${string}`))
        .groupBy(slashed.attesterAddress),
      getActiveAttesterCount(rollupAddress, client)
    ]);

    const atpDelegationsCount = Number(delegationsCountResult[0].count);
    const erc20DelegationsCount = Number(erc20DelegationsCountResult[0].count);
    const directStakesCount = Number(directStakesCountResult[0].count);  // ATP direct stakes only
    const failedDepositsLength = Number(failedDepositsLengthResult[0].count);
    const withdrawnCount = Number(withdrawnCountResult[0].count);
    const uniqueProvidersCount = Number(uniqueProvidersCountResult[0].count);
    const totalATPs = Number(totalATPsResult[0].count);
    const totalDepositsCount = Number(totalDepositsCountResult[0].count);

    // Total delegations includes both ATP-based and ERC20-based
    const totalDelegationsCount = atpDelegationsCount + erc20DelegationsCount;

    // Calculate ERC20 direct deposits (not tracked separately, derived from deposit table)
    // ERC20 direct deposits = Total deposits - ATP delegations - ERC20 delegations - ATP direct stakes
    // Note: This only counts activated validators, not those still in queue
    // Note: Failed deposits are tracked in stakedWithProvider/staked tables but NOT in deposit table,
    // so we add failedDepositsLength to balance the equation
    const erc20DirectDepositsRaw = totalDepositsCount + failedDepositsLength - atpDelegationsCount - erc20DelegationsCount - directStakesCount;

    // Guard against negative values during re-indexing or data inconsistencies
    if (erc20DirectDepositsRaw < 0) {
      console.error('ERC20 direct deposits calculation is negative - data inconsistency detected', {
        result: erc20DirectDepositsRaw,
        timestamp: new Date().toISOString(),
        breakdown: {
          totalDepositsCount,
          failedDepositsLength,
          atpDelegationsCount,
          erc20DelegationsCount,
          directStakesCount,
        },
        calculation: `${totalDepositsCount} + ${failedDepositsLength} - ${atpDelegationsCount} - ${erc20DelegationsCount} - ${directStakesCount} = ${erc20DirectDepositsRaw}`,
        note: 'ERC20 direct stakes are derived by subtraction. Negative value indicates event handler inconsistencies or re-indexing issues.'
      });
    }
    const erc20DirectDepositsCount = Math.max(0, erc20DirectDepositsRaw);

    // Calculate total stakes using deposit table as source of truth
    // The deposit table only contains SUCCESSFUL deposits (Rollup:Deposit events)
    // Failed deposits (Rollup:FailedDeposit events) are separate and NOT in the deposit table
    // Total active stakes = successful deposits - withdrawals
    // NOTE: Do NOT subtract failedDepositsLength here - failed deposits are never
    // added to the deposit table (they trigger a separate FailedDeposit event)
    const totalStakes = totalDepositsCount - withdrawnCount;

    // Per-attester latest-event maps. Used both to compute the EXITING
    // bucket and to apportion slashed amounts across status buckets.
    //
    // Coerce timestamps to bigint at the boundary — `MAX(bigint)`
    // usually comes back as bigint via postgres-js's int8 parser, but
    // be defensive (parser config drift would silently degrade
    // comparisons below to lossy Number ops).
    const latestDepositByAttester = new Map<string, bigint>();
    for (const r of latestDepositsByAttester) {
      latestDepositByAttester.set(r.attesterAddress, BigInt(r.maxTimestamp));
    }
    const latestInitiateByAttester = new Map<string, bigint>();
    for (const r of latestInitiatesByAttester) {
      latestInitiateByAttester.set(r.attesterAddress, BigInt(r.maxTimestamp));
    }
    const latestFinalizeByAttester = new Map<string, bigint>();
    for (const r of latestFinalizesByAttester) {
      latestFinalizeByAttester.set(r.attesterAddress, BigInt(r.maxTimestamp));
    }

    let exitingCount = 0;
    for (const r of latestInitiatesByAttester) {
      const finalizeTs = latestFinalizeByAttester.get(r.attesterAddress);
      const initiateTs = BigInt(r.maxTimestamp);
      if (finalizeTs === undefined || initiateTs > finalizeTs) {
        exitingCount++;
      }
    }

    // Clamp `activeCount` to the indexer's view of the registered set.
    // Chain (`getActiveAttesterCount`) and indexer (`totalStakes`) can
    // drift by a block or two; if the chain reports `activeCount >
    // totalStakes - exitingCount`, the dashboard's `totalVL − activeVL`
    // subline math would go negative. Clamp keeps the invariant
    // `0 ≤ activeCount ≤ totalStakes - exitingCount` so downstream
    // values stay non-negative.
    const rawActiveCount = Number(activeAttesterCount);
    const activeCountCeiling = Math.max(0, totalStakes - exitingCount);
    const activeCount = Math.min(rawActiveCount, activeCountCeiling);
    const zombieCount = Math.max(0, totalStakes - activeCount - exitingCount);

    // Slash apportionment by status. We need this to deduct slashed
    // amounts from headline TVL — the deposit-time `stakedAmount` and
    // the `activationThreshold × count` shortcut both overstate when
    // any attester has been slashed. Classification uses the shared
    // `classifyAttesterStatus` helper so the priority logic stays in
    // one place.
    const activationThresholdBig = BigInt(activationThreshold);
    const ejectionThresholdBig = BigInt(ejectionThreshold);
    const zombieSlashCutoff = activationThresholdBig > ejectionThresholdBig
      ? activationThresholdBig - ejectionThresholdBig
      : 0n;

    let slashedActive = 0n;
    let slashedExiting = 0n;
    let slashedZombie = 0n;

    for (const r of slashSumsByAttester) {
      // `r.totalAmount` is typed `bigint` via `sql<bigint>`, but at
      // runtime postgres-js returns SQL `numeric` (the result type of
      // `SUM(bigint)` in Postgres) as a STRING. JS's `+` operator with
      // `bigint + string` does string-concatenation, not numeric add,
      // and the resulting comparison `nominalTotal > slashedRegistered`
      // coerces both to Number — turning the huge concatenated string
      // into `Infinity` and silently zeroing the headline TVL. Coerce
      // to bigint explicitly here, at the boundary.
      const totalSlashedBig = BigInt(r.totalAmount);

      // An attester with a Slashed event MUST have a prior Deposit
      // (the protocol can't slash a non-existent attester) — so
      // `hasDeposit: true` is safe. `latestDeposit` may still be
      // missing in pathological indexer states (event re-ordering);
      // the classifier treats that the same as no-finalize-after-no-
      // deposit (won't fall into EXITED) which is the right answer.
      const status = classifyAttesterStatus({
        hasDeposit: true,
        latestDeposit: latestDepositByAttester.get(r.attesterAddress),
        latestInitiate: latestInitiateByAttester.get(r.attesterAddress),
        latestFinalize: latestFinalizeByAttester.get(r.attesterAddress),
        totalSlashed: totalSlashedBig,
        zombieSlashCutoff,
      });

      // Defense-in-depth cap at activation threshold. Per the v4
      // `StakingLib.slash` source, the contract emits the
      // *capped* `slashAmount = Math.min(_amount, effectiveBalance)`,
      // and we've filtered the SQL to canonical-rollup-only above —
      // so per-attester sum is mathematically bounded by activation
      // already. The cap here is belt-and-braces against a future
      // contract version that emits notional amounts, an indexer
      // event-duplication bug, or any other shape we haven't
      // anticipated.
      const cappedSlash = totalSlashedBig > activationThresholdBig
        ? activationThresholdBig
        : totalSlashedBig;

      switch (status) {
        case "ACTIVE":
          slashedActive += cappedSlash;
          break;
        case "EXITING":
          slashedExiting += cappedSlash;
          break;
        case "ZOMBIE":
          slashedZombie += cappedSlash;
          break;
        // EXITED / NOT_REGISTERED: tokens are gone (or never there);
        // their slashes don't affect on-contract TVL.
      }
    }

    const slashedRegistered = slashedActive + slashedExiting + slashedZombie;

    // Headline TVL math: start from the nominal value (count × threshold)
    // and subtract the slashed amount for that bucket. Clamp at 0 to
    // tolerate small drift between chain and indexer (e.g., reward
    // accumulation we don't track could leave actual on-chain balance
    // slightly above our computed effective balance, but never below
    // zero).
    const nominalTotal = activationThresholdBig * BigInt(totalStakes);
    const totalValueLocked = nominalTotal > slashedRegistered ? nominalTotal - slashedRegistered : 0n;

    const nominalActive = activationThresholdBig * BigInt(activeCount);
    const activeValueLocked = nominalActive > slashedActive ? nominalActive - slashedActive : 0n;

    const response: StakingSummaryResponse = {
      totalValueLocked: totalValueLocked.toString(),
      totalStakers: totalStakes,
      currentAPR: currentAPR,
      // Active-only TVL — the primary display number on the dashboard.
      // Sized so productive stake is highlighted; UI shows exiting +
      // zombie context as a smaller subline.
      activeValueLocked: activeValueLocked.toString(),
      stats: {
        totalStakes: totalStakes,
        activeStakes: activeCount,
        exitingStakes: exitingCount,
        zombieStakes: zombieCount,
        delegatedStakes: totalDelegationsCount,
        atpDelegatedStakes: atpDelegationsCount,
        erc20DelegatedStakes: erc20DelegationsCount,
        directStakes: directStakesCount,
        erc20DirectStakes: erc20DirectDepositsCount,  // ERC20 direct deposits (own validator registrations)
        failedDeposits: failedDepositsLength,
        activeProviders: uniqueProvidersCount,
        totalATPs: totalATPs,
        activationThreshold: activationThreshold
      }
    };

    return c.json(response);

  } catch (error) {
    console.error('Error fetching staking summary:', error);
    return c.json({ error: 'Failed to fetch staking summary' }, 500);
  }
}
