/**
 * Staking API Response Types
 */

import type { StakeStatus } from './atp.types';

export interface StakingStats {
  totalStakes: number;
  delegatedStakes: number;
  atpDelegatedStakes: number;
  erc20DelegatedStakes: number;
  directStakes: number;              // ATP direct stakes (via Staker contract)
  erc20DirectStakes: number;         // ERC20 direct stakes (own validator registrations via Rollup.deposit)
  failedDeposits: number;
  activeProviders: number;
  totalATPs: number;
  activationThreshold: string;
}

export interface StakingSummaryResponse {
  totalValueLocked: string;
  totalStakers: number;
  currentAPR: number;
  stats: StakingStats;
}

/**
 * Fields common to every "this is where the stake currently lives" hint
 * the indexer emits. The dashboard uses these to short-circuit its
 * on-chain probe; null `moveWithRollup` means the indexer couldn't decode
 * it and the dashboard should fall back to the probe.
 *
 * Both fields are optional in the response type. This is purely a
 * TypeScript-consumer compatibility hedge: older clients pre-dating this
 * field, or any future indexer regression that returns rows without the
 * hint, both keep type-checking. The runtime payload from this indexer
 * always sets them.
 */
interface EffectiveRollupFields {
  /** Decoded from the originating tx's calldata. `null` if the entry
   *  point isn't a recognised stake function (future variants, manual
   *  contract interaction, etc.). */
  moveWithRollup?: boolean | null;
  /** The rollup currently believed to hold the live record. Tracks
   *  canonical migrations for `moveWithRollup = true` rows; equals
   *  `rollupAddress` otherwise. */
  effectiveRollup?: string;
}

export interface DirectStakeBreakdown extends EffectiveRollupFields {
  atpAddress: string;
  attesterAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  hasFailedDeposit: boolean;
  failedDepositTxHash: string | null;
  failureReason: string | null;
  status: StakeStatus;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  providerId?: number;
  providerName?: string;
  providerLogo?: string;
}

export interface DelegationBreakdown extends EffectiveRollupFields {
  atpAddress: string;
  providerId: number;
  providerName: string;
  providerLogo: string;
  attesterAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  splitContract: string;
  providerTakeRate: number;
  providerRewardsRecipient: string;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  hasFailedDeposit: boolean;
  failedDepositTxHash: string | null;
  failureReason: string | null;
  status: StakeStatus;
}

export interface Erc20DelegationBreakdown extends EffectiveRollupFields {
  providerId: number;
  providerName: string;
  providerLogo: string;
  attesterAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  splitContract: string;
  providerTakeRate: number;
  providerRewardsRecipient: string;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  hasFailedDeposit: boolean;
  failedDepositTxHash: string | null;
  failureReason: string | null;
  status: StakeStatus;
}

export interface Erc20DirectStakeBreakdown extends EffectiveRollupFields {
  attesterAddress: string;
  withdrawerAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  hasFailedDeposit: boolean;
  failedDepositTxHash: string | null;
  failureReason: string | null;
  status: StakeStatus;
}

export interface BeneficiaryStakingOverviewResponse {
  totalStaked: string;
  totalDirectStaked: string;
  totalDelegated: string;
  totalErc20Delegated: string;
  totalErc20DirectStaked: string;
  directStakeBreakdown: DirectStakeBreakdown[];
  delegationBreakdown: DelegationBreakdown[];
  erc20DelegationBreakdown: Erc20DelegationBreakdown[];
  erc20DirectStakeBreakdown: Erc20DirectStakeBreakdown[];
}
