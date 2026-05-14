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
  createdAtBlock: string;
  createdAtTx: string;
  createdAtTime: number;
  stakes: ProviderStake[];
  takeRateHistory: ProviderTakeRateUpdate[];
  providerSelfStake?: string[];
}
