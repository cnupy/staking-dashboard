import { useQuery } from '@tanstack/react-query'
import { config } from '@/config'
import type { ATPData, StakeStatus } from './index'
import { stringToBigInt } from '@/utils/atpFormatters'

/**
 * Indexer-supplied hint: which rollup currently holds the live record for
 * this stake, plus the decoded `moveWithRollup` from the originating tx.
 * Used by the dashboard's unstake-routing probe to short-circuit on the
 * fast path; null `moveWithRollup` means the probe should run normally.
 *
 * Non-optional here even though the wire-format types declare both fields
 * optional. `transformATPDetailsResponse` normalises missing values to
 * `(rollupAddress, null)` so this contract holds for everything that
 * leaves the hook. Consumers can rely on the concrete shape without
 * extra null-guards.
 */
interface EffectiveRollupHints {
  effectiveRollup: `0x${string}`
  moveWithRollup: boolean | null
}

export interface DirectStake extends EffectiveRollupHints {
  attesterAddress: string
  operatorAddress: string
  rollupAddress: string
  stakedAmount: bigint
  txHash: string
  timestamp: string
  blockNumber: number
  hasFailedDeposit: boolean
  failedDepositTxHash: string | null
  failureReason: string | null
  status: StakeStatus
}

export interface Delegation extends EffectiveRollupHints {
  providerId: number
  providerName?: string
  providerLogo?: string
  /** See {@link DelegationBreakdown.manualPayoutAuditUrl}. */
  manualPayoutAuditUrl?: string
  operatorAddress: string
  rollupAddress: string
  splitContract: string
  providerTakeRate: number
  providerRewardsRecipient: string
  stakedAmount: bigint
  txHash: string
  timestamp: string
  blockNumber: number
  hasFailedDeposit: boolean
  failedDepositTxHash: string | null
  failureReason: string | null
  status: StakeStatus
}

interface ATPDetailsSummary {
  totalStaked: bigint
}

export interface ATPDetailsData {
  atp: ATPData
  summary: ATPDetailsSummary
  directStakes: DirectStake[]
  delegations: Delegation[]
}

interface ATPDetailsResponse {
  atp: {
    atpAddress: string
    allocation: string
  }
  summary: {
    totalStaked: string
  }
  directStakes: DirectStake[]
  delegations: Delegation[]
}

/**
 * Transforms API response with string BigInts to proper BigInt types
 */
const transformATPDetailsResponse = (response: ATPDetailsResponse, atpData: ATPData): ATPDetailsData => {
  return {
    atp: atpData,
    summary: {
      totalStaked: stringToBigInt(response.summary.totalStaked)
    },
    // Normalise the indexer's fast-path hint into a concrete shape so
    // the rest of the dashboard can treat `effectiveRollup` /
    // `moveWithRollup` as always-present. The API handler today always
    // emits both fields, but the wire-format types mark them optional
    // (back-compat hedge) — defaulting here is the firewall.
    directStakes: response.directStakes.map(stake => ({
      ...stake,
      effectiveRollup: (stake.effectiveRollup ?? stake.rollupAddress) as `0x${string}`,
      moveWithRollup: stake.moveWithRollup ?? null,
    })),
    delegations: response.delegations.map(delegation => ({
      ...delegation,
      stakedAmount: stringToBigInt(delegation.stakedAmount),
      effectiveRollup: (delegation.effectiveRollup ?? delegation.rollupAddress) as `0x${string}`,
      moveWithRollup: delegation.moveWithRollup ?? null,
    }))
  }
}

/**
 * Fetches detailed ATP information including staking and delegation data
 */
const fetchATPDetails = async (atp: ATPData): Promise<ATPDetailsData> => {
  const response = await fetch(`${config.apiHost}/api/atp/${atp.atpAddress}/details`)

  if (!response.ok) {
    throw new Error(`Failed to fetch ATP details: ${response.statusText}`)
  }

  const data: ATPDetailsResponse = await response.json()
  return transformATPDetailsResponse(data, atp)
}

/**
 * Hook to get comprehensive ATP details including staking and delegation information
 * Only fetches when isModalOpen is true
 */
export const useATPDetails = (atp: ATPData, isModalOpen: boolean = false) => {
  return useQuery({
    queryKey: ['atp-details', atp.atpAddress],
    queryFn: () => fetchATPDetails(atp),
    enabled: isModalOpen,
    staleTime: 30000,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000)
  })
}