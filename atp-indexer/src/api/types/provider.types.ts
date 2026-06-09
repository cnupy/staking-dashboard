/**
 * Provider API Response Types
 */

export interface ProviderSummary {
  id: string;
  name: string;
  commission: number;
  delegators: number;
  totalStaked: string;
  address: string;
  description: string;
  website: string;
  logo_url: string;
  providerSelfStake?: string[];
  /**
   * Operator-self-declared URL pointing at where they publish payout
   * audit reports from the `aztec-staking-payout` tool. Presence
   * means the operator distributes rewards manually rather than via
   * the on-chain split contracts; the dashboard uses this as a hint
   * to render a "manual payouts" badge / disable claim CTAs.
   */
  manualPayoutAuditUrl?: string;
}

export interface NotAssociatedStake {
  delegators: number;
  totalStaked: string;
}

export interface ProviderListResponse {
  providers: ProviderSummary[];
  totalStaked: string;
  notAssociatedStake?: NotAssociatedStake;
}

export interface ProviderStake {
  atpAddress?: string;  // Only present for ATP-based delegations
  stakerAddress: string;
  /**
   * Delegator-side recipient baked into the split contract — the address
   * that receives `10000 - providerTakeRate` of the distributed rewards.
   * For ATP delegations this is the ATP's beneficiary; for ERC20 wallet
   * delegations it's the staker's own wallet. Nullable defensively in case
   * an ATP row couldn't be joined.
   */
  beneficiary: string | null;
  splitContractAddress: string;
  rollupAddress: string;
  attesterAddress: string;
  stakedAmount: string;
  /**
   * Provider take rate (bips) recorded at the moment this stake was
   * indexed — i.e., the rate baked into the split contract's splitData
   * hash at deploy time. Distinct from the provider's *current* take
   * rate (returned at the top-level `commission` field): if the operator
   * has changed their take rate over time, older splits keep their
   * original rate and a `Split.distribute(splitData_currentRate)` call
   * reverts on hash mismatch. Callers building distribute txs MUST use
   * this per-stake value, not the provider-level current value.
   */
  providerTakeRate: number;
  /**
   * Operator-side recipient baked into the split's splitData at deploy
   * time. Same drift caveat as `providerTakeRate` — if the operator
   * changed their rewards recipient, older splits still expect the old
   * address in the recipients tuple. Use this for any distribute
   * call against this particular split, not the provider's current
   * `rewardsRecipient`.
   */
  providerRewardsRecipient: string;
  blockNumber: string;
  txHash: string;
  timestamp: number;
  source?: 'atp' | 'erc20';  // Indicates the delegation source
}

export interface ProviderTakeRateUpdate {
  newTakeRate: number;
  previousTakeRate: number;
  updatedAtBlock: string;
  updatedAtTx: string;
  updatedAtTime: number;
}

export interface ProviderDetailsResponse {
  id: string;
  name: string;
  description: string;
  email: string;
  website: string;
  logoUrl: string;
  discord: string;
  commission: number;
  address: string;
  totalStaked: string;
  networkTotalStaked: string;
  delegators: number;
  /**
   * Number of attesters delegating to this provider whose latest event
   * is `withdrawInitiated` (mid-exit). Omitted when zero. Separate from
   * `delegators` (which is ACTIVE-only) so the headline number reflects
   * productive stake.
   */
  exitingDelegators?: number;
  /** Effective-balance sum (post-slash) of the exiting bucket. */
  exitingStaked?: string;
  /**
   * Number of attesters delegating to this provider classified as
   * zombie (slashed below ejection threshold; still registered but not
   * validating). Omitted when zero.
   */
  zombieDelegators?: number;
  /** Effective-balance sum (post-slash) of the zombie bucket. */
  zombieStaked?: string;
  createdAtBlock: string;
  createdAtTx: string;
  createdAtTime: number;
  stakes: ProviderStake[];
  takeRateHistory: ProviderTakeRateUpdate[];
  providerSelfStake?: string[];
  /**
   * Operator-self-declared URL pointing at where they publish payout
   * audit reports from the `aztec-staking-payout` tool. See
   * `ProviderSummary.manualPayoutAuditUrl`.
   */
  manualPayoutAuditUrl?: string;
}
