import type { Context } from 'hono';
import { db } from 'ponder:api';
import { count, sql } from 'drizzle-orm';
import { getActivationThreshold, calculateAPR, getActiveAttesterCount } from '../../../utils/rollup';
import { getCanonicalRollupAddress } from '../../utils/canonical-rollup';
import { getPublicClient } from '../../../utils/viem-client';
import type { StakingSummaryResponse } from '../../types/staking.types';
import {
  stakedWithProvider,
  erc20StakedWithProvider,
  staked,
  failedDeposit,
  provider,
  atpPosition,
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
      // "currently exiting" set (latest withdrawInitiated > latest
      // withdrawFinalized) without scanning the full event tables.
      latestInitiatesByAttester,
      latestFinalizesByAttester,
      // Authoritative active count from chain. `getActiveAttesterCount`
      // returns the VALIDATING set on the canonical rollup — excludes
      // ZOMBIE and EXITING by protocol design.
      activeAttesterCount
    ] = await Promise.all([
      getActivationThreshold(rollupAddress, client),
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
    const totalValueLocked = BigInt(activationThreshold) * BigInt(totalStakes);

    // Split `totalStakes` into ACTIVE / EXITING / ZOMBIE buckets so the
    // dashboard can show the productive-stake number prominently and
    // de-emphasise the rest.
    //
    // ACTIVE comes straight from the chain (VALIDATING on canonical
    // rollup). Authoritative.
    //
    // EXITING is derived from the indexer: attesters whose latest
    // `withdrawInitiated` timestamp exceeds their latest
    // `withdrawFinalized` (or who have an initiate but no finalize at
    // all). Same logic the canonical-rollup-updated handler uses for
    // pinning effectiveRollup.
    //
    // ZOMBIE is derived by subtraction: total registered - active -
    // exiting. We don't independently track zombie state (would require
    // per-attester slash accounting + ejection threshold), and accept
    // that this includes any small drift between the indexer's view of
    // "still registered" and the chain's view (e.g., attesters who
    // deposited on a now-legacy rollup, never migrated, and aren't on
    // canonical's active set).
    const latestFinalizeByAttester = new Map<string, bigint>();
    for (const r of latestFinalizesByAttester) {
      latestFinalizeByAttester.set(r.attesterAddress, r.maxTimestamp);
    }
    let exitingCount = 0;
    for (const r of latestInitiatesByAttester) {
      const finalizeTs = latestFinalizeByAttester.get(r.attesterAddress);
      if (finalizeTs === undefined || r.maxTimestamp > finalizeTs) {
        exitingCount++;
      }
    }
    const activeCount = Number(activeAttesterCount);
    // Clamp to 0 — small drift between chain and indexer views can
    // produce a transient negative, but the user-visible count must be
    // a non-negative integer.
    const zombieCount = Math.max(0, totalStakes - activeCount - exitingCount);

    const activeValueLocked = BigInt(activationThreshold) * BigInt(activeCount);

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
