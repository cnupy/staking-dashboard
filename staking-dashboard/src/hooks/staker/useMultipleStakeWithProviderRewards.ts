import { useReadContracts } from 'wagmi'
import { ERC20Abi } from '@/contracts/abis/ERC20'
import { calculateTotalUserShareFromSplitRewards } from '@/utils/rewardCalculations'
import { useStakingAssetTokenDetails } from '@/hooks/stakingRegistry'
import { contracts } from '@/contracts'
import type { Delegation } from '@/hooks/atp'
import type { StakeWithProviderReward } from './types'

interface MultipleStakeWithProviderRewardsParams {
  delegations: Delegation[]
  enabled?: boolean
}

/**
 * Hook to calculate rewards for multiple delegations (stakeWithProvider method)
 *
 * Reward Calculation Logic:
 * 1. Get rollup rewards: rollup.getSequencerRewards(splitContract)
 * 2. Get split contract balance: stakingToken.balanceOf(splitContract)
 * 3. Calculate user's share from both sources using take rate
 */
export const useMultipleStakeWithProviderRewards = ({
  delegations,
  enabled = true
}: MultipleStakeWithProviderRewardsParams) => {
  const { stakingAssetAddress: tokenAddress } = useStakingAssetTokenDetails()

  // Build contracts array for both rollup rewards and split balance queries
  const rewardContracts = tokenAddress && delegations.length > 0
    ? delegations.flatMap(delegation => [
        // Query rollup rewards
        {
          address: contracts.rollup.address,
          abi: contracts.rollup.abi,
          functionName: 'getSequencerRewards',
          args: [delegation.splitContract as `0x${string}`],
        },
        // Query split contract balance
        {
          address: tokenAddress as `0x${string}`,
          abi: ERC20Abi,
          functionName: 'balanceOf',
          args: [delegation.splitContract as `0x${string}`],
        },
      ])
    : []

  // Get rewards from both rollup and split contracts
  const { data: rewardData, isLoading, error, refetch } = useReadContracts({
    contracts: rewardContracts,
    query: {
      enabled: !!tokenAddress && delegations.length > 0 && enabled,
    },
  })

  // Calculate user rewards for each delegation
  const delegationRewards: StakeWithProviderReward[] = delegations.map((delegation, index) => {
    const rollupRewards = (rewardData?.[index * 2]?.result as bigint) || 0n
    const splitBalance = (rewardData?.[index * 2 + 1]?.result as bigint) || 0n

    const totalRewards = rollupRewards + splitBalance
    const userRewards = calculateTotalUserShareFromSplitRewards(
      rollupRewards,
      splitBalance,
      0n, // warehouse balance (omitted for this flow)
      delegation.providerTakeRate
    )

    return {
      providerId: delegation.providerId,
      splitContract: delegation.splitContract,
      totalRewards,
      userRewards,
      takeRate: delegation.providerTakeRate
    }
  })

  // Calculate total user rewards across all delegations
  const totalUserRewards = delegationRewards.reduce((sum, delegation) => sum + delegation.userRewards, 0n)

  return {
    delegationRewards,
    totalUserRewards,
    isLoading,
    error,
    isSuccess: !!rewardData,
    refetch
  }
}
