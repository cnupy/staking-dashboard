import type { Context } from 'hono';
import { db } from 'ponder:api';
import { inArray } from 'drizzle-orm';
import { checksumAddress, normalizeAddress } from '../../../utils/address';
import { getAllProviderMetadata } from '../../../utils/provider-metadata';
import type { ProviderListResponse } from '../../types/provider.types';
import { fetchFailedDeposits, markStakesWithFailedDeposits } from '../../../utils/failed-deposits';
import { getActivationThreshold, getLocalEjectionThreshold } from '../../../utils/rollup';
import { getCanonicalRollupAddress } from '../../utils/canonical-rollup';
import { getPublicClient } from '../../../utils/viem-client';
import { buildAttesterStateLookup } from '../../utils/attester-state';
import {
  provider,
  stakedWithProvider,
  erc20StakedWithProvider,
  staked
} from 'ponder:schema';

/**
 * Handle GET /api/providers
 * List all providers in frontend-compatible format
 */
export async function handleProviderList(c: Context): Promise<Response> {
  try {
    const metadata = getAllProviderMetadata();
    const client = getPublicClient();

    // Get provider list of IDs from JSON
    const providerIds = Array.from(metadata.keys());

    const rollupAddress = await getCanonicalRollupAddress(client);
    const [
      activationThreshold,
      ejectionThreshold,
      dbProviders,
      atpDelegations,
      erc20Delegations,
      allDirectStakes,
    ] = await Promise.all([
      getActivationThreshold(rollupAddress, client),
      getLocalEjectionThreshold(rollupAddress, client),
      db.select().from(provider).where(inArray(provider.providerIdentifier, providerIds)),
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
        stakedAmount: staked.stakedAmount
      }).from(staked)
    ]);

    // Build a per-attester status + effective-balance lookup. Used
    // to filter the provider list (and "Not Associated" bucket) down
    // to ACTIVE attesters only — exiting and zombie sequencers
    // shouldn't inflate a provider's headline numbers — and to use
    // effective balance (deposit - slashed) instead of deposit-time
    // amount in the totals.
    const attesterState = await buildAttesterStateLookup({
      db,
      activationThreshold: BigInt(activationThreshold),
      ejectionThreshold: BigInt(ejectionThreshold),
      canonicalRollupAddress: normalizeAddress(rollupAddress) as `0x${string}`,
    });

    // Combine ATP-based and ERC20-based delegations
    const allDelegations = [...atpDelegations, ...erc20Delegations];

    // Fetch failed deposits to filter out invalid stakes
    const attesterWithdrawerPairs = [
      ...allDelegations.map(s => ({
        attesterAddress: normalizeAddress(s.attesterAddress),
        withdrawerAddress: normalizeAddress(s.stakerAddress)
      })),
      ...allDirectStakes.map(s => ({
        attesterAddress: normalizeAddress(s.attesterAddress),
        withdrawerAddress: normalizeAddress(s.stakerAddress)
      }))
    ].filter(pair => pair.attesterAddress !== '');

    const failedDepositMap = await fetchFailedDeposits(attesterWithdrawerPairs, db);

    // Mark stakes with failed deposits and withdrawal status
    // Combine all stakes to ensure proper FIFO event consumption
    const allStakes = [
      ...allDelegations.map(s => ({ ...s, _type: 'delegation' as const })),
      ...allDirectStakes.map(s => ({ ...s, _type: 'direct' as const }))
    ];
    const markedAllStakes = markStakesWithFailedDeposits(allStakes, failedDepositMap);

    // Filter out failed deposits, unstaked, exiting, and zombie stakes.
    // Provider headline numbers should reflect *productive* sequencers
    // only — slashed-into-zombie or mid-exit sequencers no longer
    // contribute validation work, so counting them is misleading.
    const isActiveStake = (s: { hasFailedDeposit: boolean; status?: string; attesterAddress: string }) => {
      if (s.hasFailedDeposit || s.status === 'UNSTAKED') return false;
      // Per-attester lookup; non-existent attesters default to ACTIVE
      // (no slash, no exit) which is the right answer for fresh stakes.
      return attesterState(normalizeAddress(s.attesterAddress)).status === 'ACTIVE';
    };
    const validAllStakes = markedAllStakes.filter(isActiveStake);

    // Separate back into delegations and direct stakes
    const validDelegations = validAllStakes.filter(s => s._type === 'delegation');
    const validDirectStakes = validAllStakes.filter(s => s._type === 'direct');

    // Sum stake using a per-attester model. Each row contributes its
    // own deposit amount (so a multi-deposit attester is correctly
    // sized at `count × activationThreshold` nominal), but the slash
    // deduction applies once per UNIQUE attester (slashing is per
    // attester globally, not per delegation row). Without the dedupe,
    // an attester with two stake rows + a slash of X would have X
    // subtracted twice → headline understates real on-chain balance.
    //
    // Per-attester slash is also capped at the activation threshold.
    // The `attesterState` lookup already filters slashes to the
    // canonical rollup only, so per-attester sums are mathematically
    // bounded by activation. The cap here is defense-in-depth.
    const activationThresholdBig = BigInt(activationThreshold);
    const sumEffectiveBalance = (stakes: { attesterAddress: string; stakedAmount: bigint | string }[]): bigint => {
      let nominal = 0n;
      const seenAttesters = new Set<string>();
      let totalSlashes = 0n;
      for (const s of stakes) {
        nominal += BigInt(s.stakedAmount);
        const normalized = normalizeAddress(s.attesterAddress);
        if (seenAttesters.has(normalized)) continue;
        seenAttesters.add(normalized);
        const raw = attesterState(normalized).totalSlashed;
        totalSlashes += raw > activationThresholdBig ? activationThresholdBig : raw;
      }
      return nominal > totalSlashes ? nominal - totalSlashes : 0n;
    };

    // Group valid delegations by provider
    const stakesByProvider = new Map<string, typeof validDelegations>();
    const unassociatedStakesWithProvider: typeof validDelegations = [];

    for (const stake of validDelegations) {
      if (providerIds.includes(stake.providerIdentifier)) {
        if (!stakesByProvider.has(stake.providerIdentifier)) {
          stakesByProvider.set(stake.providerIdentifier, []);
        }
        stakesByProvider.get(stake.providerIdentifier)!.push(stake);
      } else {
        unassociatedStakesWithProvider.push(stake);
      }
    }

    const totalDirectStakeAmount = sumEffectiveBalance(validDirectStakes);
    const totalProviderStakeAmount = sumEffectiveBalance(validDelegations);

    // Calculate total staked across entire network (from valid stakes only)
    const networkTotalStaked = totalProviderStakeAmount + totalDirectStakeAmount

    let totalProviderSelfStakeAmount: bigint = 0n
    let totalProviderSelfStakeCount: number = 0

    // Only return provider list with metadata
    const formattedProviders = dbProviders.map((provider) => {
      const meta = metadata.get(provider.providerIdentifier);
      const providerStakes = stakesByProvider.get(provider.providerIdentifier) || [];

      // Get self-stake count
      // This is to accumulate self stakes into provider with metadata.
      // Self-stake entries are filtered to ACTIVE attesters and summed
      // by effective balance, same as delegated stakes — keeps the
      // numbers honest if a self-staked sequencer gets slashed or
      // initiates an exit.
      const declaredSelfStake = meta?.providerSelfStake ?? [];
      const activeSelfStake = declaredSelfStake.filter(
        addr => attesterState(normalizeAddress(addr)).status === 'ACTIVE',
      );
      const selfStakeCount = activeSelfStake.length;
      const selfStakeAmount = activeSelfStake.reduce(
        (sum, addr) => sum + attesterState(normalizeAddress(addr)).effectiveBalance,
        0n,
      );

      // Add provider self stake count to provider stakes
      const delegationsWithSelfStake = providerStakes.length + selfStakeCount;

      const providerTotalStaked = sumEffectiveBalance(providerStakes) + selfStakeAmount;

      totalProviderSelfStakeAmount += selfStakeAmount
      totalProviderSelfStakeCount += selfStakeCount

      return {
        id: provider.providerIdentifier,
        name: meta?.providerName || `Provider ${provider.providerIdentifier}`,
        commission: provider.providerTakeRate,
        delegators: delegationsWithSelfStake,
        totalStaked: providerTotalStaked.toString(),
        address: checksumAddress(provider.providerAdmin),
        description: meta?.providerDescription || '',
        website: meta?.providerWebsite || '',
        logo_url: meta?.providerLogoUrl || '',
        email: meta?.providerEmail || '',
        discord: meta?.discordUsername || '',
        ...(meta?.providerSelfStake && meta.providerSelfStake.length > 0 && {
          providerSelfStake: meta.providerSelfStake.map(addr => checksumAddress(addr))
        })
      };
    });


    // Accumulated stakes from unknown provider & self stake
    // Total delegations to provider without metadata + unknwon self stake - provider self stake
    const totalUnassociatedCount = unassociatedStakesWithProvider.length + validDirectStakes.length - totalProviderSelfStakeCount;

    let notAssociatedStake = undefined;

    if (totalUnassociatedCount > 0) {
      const unassociatedTotalStakedWithProvider = sumEffectiveBalance(unassociatedStakesWithProvider);

      // Subtract self-staked direct stakes (already credited to a
      // metadata-registered provider above) so they don't double-count
      // in the "Not Associated" bucket. Both sides of the subtraction
      // now use effective balance, so the math stays consistent.
      const unassociatedTotalStaked =
        unassociatedTotalStakedWithProvider + totalDirectStakeAmount - totalProviderSelfStakeAmount;
      const clampedUnassociatedTotal = unassociatedTotalStaked > 0n ? unassociatedTotalStaked : 0n;

      notAssociatedStake = {
        delegators: Math.max(0, totalUnassociatedCount),
        totalStaked: clampedUnassociatedTotal.toString()
      };
    }

    const response: ProviderListResponse = {
      providers: formattedProviders,
      totalStaked: networkTotalStaked.toString(),
      notAssociatedStake
    };

    return c.json(response);

  } catch (error) {
    console.error('Error fetching providers:', error);
    return c.json({ error: 'Failed to fetch providers' }, 500);
  }
}
