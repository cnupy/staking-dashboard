import { useMemo } from "react"
import { useAggregatedStakingData } from "@/hooks/atp/useAggregatedStakingData"
import { useMultipleProviderQueueLengths, useMultipleProviderConfigurations } from "@/hooks/stakingRegistry"
import { TOP_GROUP_SIZE, type ProviderListItem, type SortDirection, type SortField } from "@/hooks/providers/useProviderTable"

interface UseProviderTableDisplayDataParams {
  providers: ProviderListItem[]
  sortField: SortField
  sortDirection: SortDirection
  currentPage: number
  searchQuery: string
  hasUserSorted: boolean
}

/**
 * Shared display data for provider table entry points.
 * Keeps grouping and delegation calculations consistent across screens.
 */
export function useProviderTableDisplayData({
  providers,
  sortField,
  sortDirection,
  currentPage,
  searchQuery,
  hasUserSorted,
}: UseProviderTableDisplayDataParams) {
  const { delegationBreakdown, directStakeBreakdown, erc20DelegationBreakdown } = useAggregatedStakingData()

  // Create a map of providerId to total delegated amount (excluding failed deposits and unstaked)
  // Includes both ATP delegations, direct stakes, and ERC20 delegations
  const myDelegations = useMemo(() => {
    const delegationMap = new Map<number, bigint>()

    // Add ATP delegations (exclude failed and unstaked)
    delegationBreakdown
      .filter(delegation => !delegation.hasFailedDeposit && delegation.status !== 'UNSTAKED')
      .forEach(delegation => {
        const current = delegationMap.get(delegation.providerId) || 0n
        delegationMap.set(delegation.providerId, current + delegation.stakedAmount)
      })

    // Add direct stakes that match provider self-stakes (exclude failed and unstaked)
    directStakeBreakdown
      .filter(stake => stake.providerId !== undefined && !stake.hasFailedDeposit && stake.status !== 'UNSTAKED')
      .forEach(stake => {
        const current = delegationMap.get(stake.providerId!) || 0n
        delegationMap.set(stake.providerId!, current + stake.stakedAmount)
      })

    // Add ERC20 delegations (exclude failed and unstaked)
    erc20DelegationBreakdown
      .filter(delegation => !delegation.hasFailedDeposit && delegation.status !== 'UNSTAKED')
      .forEach(delegation => {
        const current = delegationMap.get(delegation.providerId) || 0n
        delegationMap.set(delegation.providerId, current + delegation.stakedAmount)
      })

    return delegationMap
  }, [delegationBreakdown, directStakeBreakdown, erc20DelegationBreakdown])

  // Get queue lengths and configurations for all providers
  const providerIds = useMemo(() => providers.map(v => Number(v.id)), [providers])
  const { queueLengths } = useMultipleProviderQueueLengths(providerIds)
  const { configurations } = useMultipleProviderConfigurations(providerIds)

  // Show the top-N group row only when on page 1, sorted by stake (default), and not searching
  const showDecentralizationBar =
    sortField === 'totalStaked' &&
    sortDirection === 'desc' &&
    currentPage === 1 &&
    !searchQuery &&
    providers.length > TOP_GROUP_SIZE

  const topGroupSize =
    showDecentralizationBar &&
    !hasUserSorted
      ? TOP_GROUP_SIZE
      : 0

  return {
    myDelegations,
    queueLengths,
    configurations,
    topGroupSize,
    showDecentralizationBar,
    topGroupSizeThreshold: TOP_GROUP_SIZE,
  }
}

