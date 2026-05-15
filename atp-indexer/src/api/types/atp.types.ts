/**
 * ATP API Response Types
 */

export type StakeStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNSTAKED';

/**
 * Fields the indexer attaches as a fast-path hint for "where this stake
 * currently lives". The dashboard short-circuits its on-chain probe when
 * these are present. Optional for TS-consumer back-compat — older
 * clients pre-dating these fields keep type-checking. See the matching
 * type in `staking.types.ts`.
 */
interface EffectiveRollupFields {
  moveWithRollup?: boolean | null;
  effectiveRollup?: string;
}

export interface ATPDirectStake extends EffectiveRollupFields {
  attesterAddress: string;
  operatorAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  totalSlashed: string;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  hasFailedDeposit: boolean;
  failedDepositTxHash: string | null;
  failureReason: string | null;
  status: StakeStatus;
}

export interface ATPDelegation extends EffectiveRollupFields {
  providerId: number;
  providerName: string;
  providerLogo: string;
  operatorAddress: string;
  rollupAddress: string;
  stakedAmount: string;
  totalSlashed: string;
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

export interface ATPDetailsResponse {
  atp: {
    atpAddress: string;
    allocation: string;
  };
  summary: {
    totalStaked: string;
    totalSlashed: string;
  };
  directStakes: ATPDirectStake[];
  delegations: ATPDelegation[];
}

export interface ATPPosition {
  address: string;
  beneficiary: string;
  allocation: string;
  type: string;
  stakerAddress: string;
  factoryAddress: string; // Factory that created this ATP
  sequentialNumber: number;
  timestamp: number;
  totalWithdrawn?: string;
  totalSlashed?: string;
  // NCATP-specific: withdrawal timestamp from staker implementation
  withdrawalTimestamp?: number | null;
}

export interface ATPBeneficiaryResponse {
  data: ATPPosition[];
}
