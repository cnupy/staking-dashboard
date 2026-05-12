import type { Address } from 'viem'

/**
 * Rewards a coinbase address has accumulated on a single rollup. The dashboard
 * fans out reward reads across every rollup the indexer has seen
 * (`/api/rollups`), so a coinbase that earned on two rollups produces two
 * `CoinbaseBreakdown` rows — one per rollup. UI disambiguates via
 * `rollupAddress`/`rollupVersion` and the claim engine routes each
 * `claimSequencerRewards` call to the matching rollup contract.
 */
export interface CoinbaseBreakdown {
  address: Address
  rewards: bigint
  source: 'manual'
  /** Rollup contract these rewards live on. */
  rollupAddress: Address
  /** Stringified uint256 registry version (e.g. "2"). Displayed as "Rollup v{version}". */
  rollupVersion?: string
}

/**
 * Represents a manually-added split contract for tracking delegation rewards
 */
export interface ManualSplitBreakdown {
  splitAddress: Address
  rewards: bigint
  userShare: bigint
  providerTakeRate: number
  source: 'manual'
}

/**
 * API response types
 */
export interface CoinbaseAddressResponse {
  coinbaseAddresses: `0x${string}`[]
}

export interface ManualSplitResponse {
  splitAddresses: `0x${string}`[]
}

export interface AddAddressResponse {
  success: boolean
}

export interface RemoveAddressResponse {
  success: boolean
}
