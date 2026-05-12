import type { Address } from "viem"
import { ATPStakingStepsWithTransaction } from "./ATPStakingStepsContext"

export type TransactionType = "delegation" | "self-stake" | "setup" | "wallet-delegation" | "wallet-direct-stake" | "claim"

/**
 * Step type for claim flows. String values so they can't collide with
 * `ATPStakingStepsWithTransaction` (numeric enum) in the cart's cross-type
 * dependency resolver.
 */
export enum ClaimStepType {
  /** claimSequencerRewards(coinbase, rollup) for a saved coinbase address. */
  CoinbaseClaim = "claim:coinbase",
  /** claimSequencerRewards(splitContract, rollup) for any rollup version —
   *  canonical or otherwise. No semantic difference; the dependency wiring
   *  treats every per-rollup claim the same. */
  SplitClaim = "claim:split-claim",
  /** Split.distribute(splitData, token, distributor). */
  SplitDistribute = "claim:split-distribute",
  /** SplitsWarehouse.withdraw(user, token). */
  SplitWithdraw = "claim:split-withdraw",
}

export const ClaimStepTypeName: Record<ClaimStepType, string> = {
  [ClaimStepType.CoinbaseClaim]: "Claim Coinbase Rewards",
  [ClaimStepType.SplitClaim]: "Claim to Split Contract",
  [ClaimStepType.SplitDistribute]: "Distribute Rewards",
  [ClaimStepType.SplitWithdraw]: "Withdraw Rewards",
}

export interface TransactionDependency<T> {
  stepType: T
  stepName?: string
  stepGroupIdentifier: string
}

export interface BaseMetadata<T> {
  stepType?: T
  stepGroupIdentifier?: string
  dependsOn?: TransactionDependency<T>[]
}

export interface DelegationMetadata extends BaseMetadata<ATPStakingStepsWithTransaction> {
  providerId?: number
  providerName?: string
  atpAddress?: Address
  amount?: bigint
  stakeCount?: number
}

export interface SelfStakeMetadata extends BaseMetadata<ATPStakingStepsWithTransaction> {
  atpAddress?: Address
  amount?: bigint
  operatorAddress?: Address
  stakeCount?: number
}

export interface SetupMetadata extends BaseMetadata<ATPStakingStepsWithTransaction> {
  atpAddress?: Address
  operatorAddress?: Address
  stakeCount?: number
}

export interface WalletDelegationMetadata extends BaseMetadata<ATPStakingStepsWithTransaction> {
  providerId?: number
  providerName?: string
  amount?: bigint
  stakeCount?: number
  walletAddress?: Address
  atpAddress?: Address // Not used for wallet delegation, but needed for type compatibility
}

export interface WalletDirectStakeMetadata extends BaseMetadata<ATPStakingStepsWithTransaction> {
  amount?: bigint
  stakeCount?: number
  walletAddress?: Address
  attesterAddress?: Address
  atpAddress?: Address // Not used for wallet direct staking, but needed for type compatibility
}

export interface ClaimMetadata extends BaseMetadata<ClaimStepType> {
  /** Coinbase whose sequencer rewards are being claimed (CoinbaseClaim). */
  coinbase?: Address
  /** Rollup contract the claim targets. */
  rollupAddress?: Address
  /** Ordinal rollup version (1-based), used for cart display only. */
  rollupVersion?: string
  /** Split contract for delegation flows. */
  splitContract?: Address
  /** Splits warehouse for the withdraw step. */
  warehouseAddress?: Address
  /** Reward token (fee asset) being claimed; needed by distribute/withdraw. */
  tokenAddress?: Address
  /** Expected reward amount at add-time (display only — chain state is authoritative at exec). */
  amount?: bigint
}

export interface RawTransaction {
  to: Address
  data: `0x${string}`
  value: bigint
}

export type TransactionStatus = 'pending' | 'executing' | 'completed' | 'failed'

interface BaseCartItem<T extends TransactionType, M> {
  id: string
  type: T
  label: string
  description?: string
  transaction: RawTransaction
  metadata?: M
  status?: TransactionStatus
  txHash?: string
  safeTxHash?: string
  error?: string
}

export type CartTransaction =
  | BaseCartItem<"delegation", DelegationMetadata>
  | BaseCartItem<"self-stake", SelfStakeMetadata>
  | BaseCartItem<"setup", SetupMetadata>
  | BaseCartItem<"wallet-delegation", WalletDelegationMetadata>
  | BaseCartItem<"wallet-direct-stake", WalletDirectStakeMetadata>
  | BaseCartItem<"claim", ClaimMetadata>

export interface AddTransactionOptions {
  preventDuplicate?: boolean
}

export interface TransactionCartContextType {
  transactions: CartTransaction[]
  addTransaction: (transaction: Omit<CartTransaction, "id">, options?: AddTransactionOptions) => void
  removeTransaction: (id: string) => void
  /**
   * Atomic replace for "singleton" entries (e.g. a warehouse withdraw whose
   * calldata is identical across delegations). Removes any existing cart entry
   * with the same raw-tx signature and appends `replacement` at the end — all
   * in one `setTransactions` call so callers don't have to coordinate the
   * remove + add themselves, and no toasts fire for the silent swap.
   */
  replaceTransactionByTx: (transaction: RawTransaction, replacement: Omit<CartTransaction, "id">) => void
  clearCart: () => void
  clearByType: (type: TransactionType) => void
  clearCompleted: () => void
  executeAll: () => Promise<void>
  isExecuting: boolean
  currentExecutingId: string | null
  moveUp: (id: string) => void
  moveDown: (id: string) => void
  checkTransactionInQueue: (transaction: RawTransaction) => boolean
  getTransaction: (id: string) => CartTransaction | undefined
  getTransactionByTx: (transaction: RawTransaction) => CartTransaction | undefined
  isSafe: boolean
  isCartOpen: boolean
  openCart: () => void
  closeCart: () => void
}
