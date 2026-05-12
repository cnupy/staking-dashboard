export interface StakeWithProviderReward {
  providerId?: number
  splitContract: string
  totalRewards: bigint
  userRewards: bigint
  takeRate: number
  /** Per-rollup `getSequencerRewards(splitContract)` breakdown — one row per
   *  rollup version the Registry has indexed. Drives the per-rollup claim
   *  fan-out at execution time. */
  rollupRewardsByRollup: Array<{
    rollupAddress: `0x${string}`
    rollupVersion: string
    rewards: bigint
  }>
  /** ERC20 balance currently sitting on the split contract. Non-zero with no
   *  per-rollup balance means a prior claim landed tokens here but distribute
   *  hasn't run yet — the claim engine needs this to surface a distribute-only
   *  recovery flow. */
  splitContractBalance: bigint
}

export interface G1Point {
  x: string
  y: string
}

export interface G2Point {
  x: [string, string]
  y: [string, string]
}
