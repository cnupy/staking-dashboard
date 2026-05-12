import type { Address } from "viem"
import { useCoinbaseRewardsAcrossRollups } from "./useCoinbaseRewardsAcrossRollups"

/**
 * Fetch rewards for multiple coinbase addresses. Thin wrapper over
 * {@link useCoinbaseRewardsAcrossRollups} — each address's `rewards` is
 * summed across all rollup versions so stranded balances on non-canonical
 * rollups appear in the claimable-rewards total.
 */
export function useMultipleCoinbaseRewards(coinbaseAddresses: Address[]) {
  return useCoinbaseRewardsAcrossRollups(coinbaseAddresses)
}
