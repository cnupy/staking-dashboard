import type { Context } from 'hono';
import { db } from 'ponder:api';
import { eq, desc, or, and } from 'drizzle-orm';
import { checksumAddress, normalizeAddress } from '../../../utils/address';
import { getProviderMetadata } from '../../../utils/provider-metadata';
import type { ProviderDetailsResponse } from '../../types/provider.types';
import { fetchFailedDeposits, filterValidStakes, markStakesWithFailedDeposits } from '../../../utils/failed-deposits';
import { getActivationThreshold, getLocalEjectionThreshold } from '../../../utils/rollup';
import { getCanonicalRollupAddress } from '../../utils/canonical-rollup';
import { getPublicClient } from '../../../utils/viem-client';
import { buildAttesterStateLookup } from '../../utils/attester-state';
import {
  provider,
  stakedWithProvider,
  erc20StakedWithProvider,
  providerTakeRateUpdate,
  staked,
  atpPosition
} from 'ponder:schema';

/**
 * Handle GET /api/providers/:id
 * Get detailed information about a specific provider
 */
export async function handleProviderDetails(c: Context): Promise<Response> {
  try {
    const id = c.req.param('id');
    const client = getPublicClient();

    const rollupAddress = await getCanonicalRollupAddress(client);
    // Fetch the all-network stake data alongside the provider-specific
    // queries. We need this to compute `networkTotalStaked` the same
    // way `/api/providers` (list) does — sum of effective ACTIVE stake,
    // slash-adjusted — so that the "% of network stake" displayed on
    // the detail page matches the list. Previously this used a
    // count × activationThreshold shortcut that didn't account for
    // finalized exits, slashes, or active-only filtering, producing a
    // larger denominator and a smaller percentage.
    const [
      activationThreshold,
      ejectionThreshold,
      providerData,
      allAtpDelegationsRows,
      allErc20DelegationsRows,
      allDirectStakesRows,
    ] = await Promise.all([
      getActivationThreshold(rollupAddress, client),
      getLocalEjectionThreshold(rollupAddress, client),
      db.select().from(provider).where(eq(provider.providerIdentifier, id)).limit(1),
      db.select({
        providerIdentifier: stakedWithProvider.providerIdentifier,
        attesterAddress: stakedWithProvider.attesterAddress,
        stakerAddress: stakedWithProvider.stakerAddress,
        stakedAmount: stakedWithProvider.stakedAmount,
        timestamp: stakedWithProvider.timestamp,
        blockNumber: stakedWithProvider.blockNumber,
        logIndex: stakedWithProvider.logIndex,
      }).from(stakedWithProvider),
      db.select({
        providerIdentifier: erc20StakedWithProvider.providerIdentifier,
        attesterAddress: erc20StakedWithProvider.attesterAddress,
        stakerAddress: erc20StakedWithProvider.stakerAddress,
        stakedAmount: erc20StakedWithProvider.stakedAmount,
        timestamp: erc20StakedWithProvider.timestamp,
        blockNumber: erc20StakedWithProvider.blockNumber,
        logIndex: erc20StakedWithProvider.logIndex,
      }).from(erc20StakedWithProvider),
      db.select({
        attesterAddress: staked.attesterAddress,
        stakerAddress: staked.stakerAddress,
        timestamp: staked.timestamp,
        blockNumber: staked.blockNumber,
        logIndex: staked.logIndex,
        stakedAmount: staked.stakedAmount,
      }).from(staked),
    ]);

    if (!providerData || providerData.length === 0) {
      return c.json({ error: 'Provider not found' }, 404);
    }

    const providerRecord = providerData[0];

    // Get provider stakes (ATP and ERC20) and take rate history. ATP rows are
    // LEFT-joined with `atpPosition` so we can expose the ATP beneficiary —
    // the delegator-side recipient baked into the split contract — directly
    // in the response. Without that join the operator-side commission flow
    // can't rebuild `splitData` to call `Split.distribute`.
    const [atpDelegationsRaw, erc20Delegations, takeRateHistory] = await Promise.all([
      db.select({
          row: stakedWithProvider,
          beneficiary: atpPosition.beneficiary,
        })
        .from(stakedWithProvider)
        .leftJoin(atpPosition, eq(stakedWithProvider.atpAddress, atpPosition.address))
        .where(eq(stakedWithProvider.providerIdentifier, id))
        .orderBy(desc(stakedWithProvider.blockNumber), desc(stakedWithProvider.logIndex)),
      db.select().from(erc20StakedWithProvider)
        .where(eq(erc20StakedWithProvider.providerIdentifier, id))
        .orderBy(desc(erc20StakedWithProvider.blockNumber), desc(erc20StakedWithProvider.logIndex)),
      db.select().from(providerTakeRateUpdate)
        .where(eq(providerTakeRateUpdate.providerIdentifier, id))
        .orderBy(desc(providerTakeRateUpdate.timestamp))
    ]);

    const atpDelegations = atpDelegationsRaw.map(r => ({ ...r.row, beneficiary: r.beneficiary }));

    // Combine ATP and ERC20 delegations. The `beneficiary` we attach here is
    // the address baked into the split contract:
    //   - ATP delegations  → joined from `atpPosition.beneficiary`
    //   - ERC20 delegations → the staker's wallet (= `stakerAddress`)
    const allDelegations = [
      ...atpDelegations.map(d => ({ ...d, _source: 'atp' as const })),
      ...erc20Delegations.map(d => ({ ...d, _source: 'erc20' as const, beneficiary: d.stakerAddress }))
    ];

    // Build attester-withdrawer pairs from all delegations
    const attesterWithdrawerPairs = allDelegations
      .map(s => ({
        attesterAddress: normalizeAddress(s.attesterAddress),
        withdrawerAddress: normalizeAddress(s.stakerAddress)
      }))
      .filter(pair => pair.attesterAddress !== '');

    // Fetch ALL direct stakes that share the same attester-withdrawer pairs
    // This is necessary for correct FIFO event consumption
    const directStakesWithSamePairs = attesterWithdrawerPairs.length > 0
      ? await db.select().from(staked)
          .where(
            or(
              ...attesterWithdrawerPairs.map(pair =>
                and(
                  eq(staked.attesterAddress, pair.attesterAddress as `0x${string}`),
                  eq(staked.stakerAddress, pair.withdrawerAddress as `0x${string}`)
                )
              )
            )
          )
      : [];

    // Fetch failed deposits to filter out invalid stakes
    const failedDepositMap = await fetchFailedDeposits(attesterWithdrawerPairs, db);

    // Combine all stakes to ensure proper FIFO event consumption
    const allStakes = [
      ...allDelegations.map(s => ({ ...s, _type: 'delegation' as const })),
      ...directStakesWithSamePairs.map(s => ({ ...s, _type: 'direct' as const }))
    ];
    const validAllStakes = filterValidStakes(allStakes, failedDepositMap);

    // Build per-attester status + effective-balance lookup. Used both
    // for the provider's status buckets and for computing the
    // network-wide active stake (denominator of the % calculation).
    const attesterState = await buildAttesterStateLookup({
      db,
      activationThreshold: BigInt(activationThreshold),
      ejectionThreshold: BigInt(ejectionThreshold),
      canonicalRollupAddress: normalizeAddress(rollupAddress) as `0x${string}`,
    });
    const activationThresholdBig = BigInt(activationThreshold);

    // Compute the network-wide active stake the same way
    // `/api/providers` (list) does: classify and filter every stake
    // network-wide, then sum effective balance (with per-attester
    // slash dedupe). Mirrors `provider/list.ts` so the "% of network
    // stake" displayed here matches the list view.
    //
    // TODO: extract this and `provider/list.ts`'s identical pipeline
    // into a shared util to prevent future drift.
    const networkAllDelegations = [...allAtpDelegationsRows, ...allErc20DelegationsRows];
    const networkAttesterWithdrawerPairs = [
      ...networkAllDelegations.map(s => ({
        attesterAddress: normalizeAddress(s.attesterAddress),
        withdrawerAddress: normalizeAddress(s.stakerAddress),
      })),
      ...allDirectStakesRows.map(s => ({
        attesterAddress: normalizeAddress(s.attesterAddress),
        withdrawerAddress: normalizeAddress(s.stakerAddress),
      })),
    ].filter(pair => pair.attesterAddress !== '');

    const networkFailedDepositMap = await fetchFailedDeposits(networkAttesterWithdrawerPairs, db);
    const networkAllStakes = [
      ...networkAllDelegations.map(s => ({ ...s, _type: 'delegation' as const })),
      ...allDirectStakesRows.map(s => ({ ...s, _type: 'direct' as const })),
    ];
    const networkMarked = markStakesWithFailedDeposits(networkAllStakes, networkFailedDepositMap);
    const networkActiveStakes = networkMarked
      .filter(s => !s.hasFailedDeposit && s.status !== 'UNSTAKED')
      .filter(s => attesterState(normalizeAddress(s.attesterAddress)).status === 'ACTIVE');

    // Sum effective balance with per-attester slash dedupe (same shape
    // as `sumEffectiveBalance` in `provider/list.ts`).
    let networkTotalStakedBig = 0n;
    {
      let nominal = 0n;
      const seen = new Set<string>();
      let totalSlashes = 0n;
      for (const s of networkActiveStakes) {
        nominal += BigInt(s.stakedAmount);
        const normalized = normalizeAddress(s.attesterAddress);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const raw = attesterState(normalized).totalSlashed;
        totalSlashes += raw > activationThresholdBig ? activationThresholdBig : raw;
      }
      networkTotalStakedBig = nominal > totalSlashes ? nominal - totalSlashes : 0n;
    }
    const networkTotalStaked = networkTotalStakedBig;

    const metadata = getProviderMetadata(providerRecord.providerIdentifier);

    // Bucket THIS provider's delegations by attester status. The
    // ACTIVE bucket drives the headline `delegators` / `totalStaked`
    // (same as before); EXITING and ZOMBIE are new and surface
    // separately on the provider detail page so operators / delegators
    // can see in-flight exits and slashed-out sequencers without those
    // affecting the headline "productive stake" number.
    //
    // Each bucket's amount uses the same per-attester slash-dedupe
    // pattern as the headline — sum row-level `stakedAmount`, subtract
    // capped slash once per unique attester.
    const providerValidDelegations = validAllStakes.filter(s => s._type === 'delegation');

    function sumBucket(rows: typeof providerValidDelegations): { count: number; amount: bigint } {
      let nominal = 0n;
      const seen = new Set<string>();
      let totalSlashes = 0n;
      for (const s of rows) {
        nominal += BigInt(s.stakedAmount);
        const normalized = normalizeAddress(s.attesterAddress);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const raw = attesterState(normalized).totalSlashed;
        totalSlashes += raw > activationThresholdBig ? activationThresholdBig : raw;
      }
      return {
        count: rows.length,
        amount: nominal > totalSlashes ? nominal - totalSlashes : 0n,
      };
    }

    const activeRows = providerValidDelegations.filter(
      s => attesterState(normalizeAddress(s.attesterAddress)).status === 'ACTIVE',
    );
    const exitingRows = providerValidDelegations.filter(
      s => attesterState(normalizeAddress(s.attesterAddress)).status === 'EXITING',
    );
    const zombieRows = providerValidDelegations.filter(
      s => attesterState(normalizeAddress(s.attesterAddress)).status === 'ZOMBIE',
    );

    const activeBucket = sumBucket(activeRows);
    const exitingBucket = sumBucket(exitingRows);
    const zombieBucket = sumBucket(zombieRows);

    // Self-stake roster: filter to ACTIVE attesters only and sum by
    // effective balance. Self-stake addresses are inherently unique
    // per provider so a single reduce is correct here.
    const declaredSelfStake = metadata?.providerSelfStake ?? [];
    const activeSelfStake = declaredSelfStake.filter(
      addr => attesterState(normalizeAddress(addr)).status === 'ACTIVE',
    );
    const providerSelfStakeCount = activeSelfStake.length;
    const totalProviderSelfStakes = activeSelfStake.reduce(
      (sum, addr) => sum + attesterState(normalizeAddress(addr)).effectiveBalance,
      0n,
    );

    // Keep historical variable name for the response — represents
    // provider's productive (ACTIVE) stake.
    const totalDelegations = activeBucket.amount;
    const totalStaked = totalDelegations + totalProviderSelfStakes;
    // For consistency with how the list endpoint structures
    // `validDelegations`, the post-filter ACTIVE set is what feeds
    // into the headline count.
    const validDelegations = activeRows;

    const response: ProviderDetailsResponse = {
      id: providerRecord.providerIdentifier,
      name: metadata?.providerName || `Provider ${providerRecord.providerIdentifier}`,
      description: metadata?.providerDescription || '',
      email: metadata?.providerEmail || '',
      website: metadata?.providerWebsite || '',
      logoUrl: metadata?.providerLogoUrl || '',
      discord: metadata?.discordUsername || '',
      commission: providerRecord.providerTakeRate,
      address: checksumAddress(providerRecord.providerAdmin),
      totalStaked: totalStaked.toString(),
      networkTotalStaked: networkTotalStaked.toString(),
      delegators: validDelegations.length + providerSelfStakeCount,
      // Per-status buckets. Only emitted when non-zero to keep the
      // response payload tight for healthy providers; the dashboard
      // hides the subline when both are zero. Self-stake addresses are
      // NOT counted in these buckets (those are part of the active
      // headline via `totalStaked` + `delegators`).
      ...(exitingBucket.count > 0 && {
        exitingDelegators: exitingBucket.count,
        exitingStaked: exitingBucket.amount.toString(),
      }),
      ...(zombieBucket.count > 0 && {
        zombieDelegators: zombieBucket.count,
        zombieStaked: zombieBucket.amount.toString(),
      }),
      createdAtBlock: providerRecord.blockNumber.toString(),
      createdAtTx: providerRecord.txHash,
      createdAtTime: Number(providerRecord.timestamp),

      // Showing all provider historical delegations without filter, so the user could know all of the split contract addresses
      stakes: allDelegations.map(stake => ({
        // ATP delegations have atpAddress, ERC20 delegations don't
        ...(stake._source === 'atp' && 'atpAddress' in stake && { atpAddress: checksumAddress(stake.atpAddress) }),
        stakerAddress: checksumAddress(stake.stakerAddress),
        // Delegator-side recipient on the split contract — required to
        // rebuild splitData for `Split.distribute`. Nullable defensively in
        // case the ATP row couldn't be joined.
        beneficiary: stake.beneficiary ? checksumAddress(stake.beneficiary) : null,
        splitContractAddress: checksumAddress(stake.splitContractAddress),
        rollupAddress: checksumAddress(stake.rollupAddress),
        attesterAddress: checksumAddress(stake.attesterAddress),
        stakedAmount: stake.stakedAmount.toString(),
        // Per-stake snapshot of the provider config at the moment this
        // stake was indexed — i.e., the values baked into the split's
        // splitData hash at deploy time. See type doc on ProviderStake.
        providerTakeRate: stake.providerTakeRate,
        providerRewardsRecipient: checksumAddress(stake.providerRewardsRecipient),
        blockNumber: stake.blockNumber.toString(),
        txHash: stake.txHash,
        timestamp: Number(stake.timestamp),
        source: stake._source
      })),
      takeRateHistory: takeRateHistory.map(update => ({
        newTakeRate: update.newTakeRate,
        previousTakeRate: update.previousTakeRate,
        updatedAtBlock: update.blockNumber.toString(),
        updatedAtTx: update.txHash,
        updatedAtTime: Number(update.timestamp)
      })),
      ...(metadata?.providerSelfStake && metadata.providerSelfStake.length > 0 && {
        providerSelfStake: metadata.providerSelfStake.map(addr => checksumAddress(addr))
      }),
      ...(metadata?.manualPayoutAuditUrl && {
        manualPayoutAuditUrl: metadata.manualPayoutAuditUrl
      })
    };

    return c.json(response);

  } catch (error) {
    console.error('Error fetching provider details:', error);
    return c.json({ error: 'Failed to fetch provider details' }, 500);
  }
}
