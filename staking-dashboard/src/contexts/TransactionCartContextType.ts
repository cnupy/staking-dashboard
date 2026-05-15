import type { Address } from "viem"
import { ATPStakingStepsWithTransaction } from "./ATPStakingStepsContext"

export type TransactionType = "delegation" | "self-stake" | "setup" | "wallet-delegation" | "wallet-direct-stake" | "claim" | "unstake" | "action"

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

/**
 * Step type for unstake/withdraw flows. Three paths (wallet ERC20, ATP staker,
 * governance) × two phases (initiate, finalize) = six leaves. String values
 * keep them from colliding with other step-type enums.
 *
 * Unstake operations are `msg.sender`-bound (the contract checks the caller
 * matches the stored withdrawer), so they cannot be batched via Multicall3.
 * For Safe wallets the Safe contract IS the stored withdrawer so a Safe
 * proposal containing many initiate/finalize calls executes natively.
 */
export enum UnstakeStepType {
  /** Rollup.initiateWithdraw(attester, recipient) — wallet ERC20 direct-staker path. */
  InitiateWithdrawRollup = "unstake:initiate-rollup",
  /** Staker.initiateWithdraw(version, attester) — ATP staker path. */
  InitiateWithdrawStaker = "unstake:initiate-staker",
  /** Staker.initiateWithdrawFromGovernance(amount) — governance ATP path. */
  InitiateWithdrawGovernance = "unstake:initiate-governance",
  /** Governance.initiateWithdraw(to, amount) — direct-deposit ERC20 holders. */
  InitiateWithdrawGovernanceWallet = "unstake:initiate-governance-wallet",
  /**
   * Rollup.finalizeWithdraw(attester) — used by BOTH the wallet ERC20
   * direct-staker path AND the ATP staker path. ATP finalize sidesteps
   * the Staker because `Staker.finalizeWithdraw` internally calls
   * `Rollup.finaliseWithdraw` (British spelling, doesn't exist) and
   * reverts. See `useFinalizeWithdraw.ts` for the original note.
   */
  FinalizeWithdrawRollup = "unstake:finalize-rollup",
  /**
   * @deprecated Do NOT use — the Staker's finalize forwarder reverts
   * due to a British-vs-American spelling mismatch. Kept here only so
   * any localStorage cart entries persisted under this step type from
   * an older build still deserialize cleanly. All new finalize entries
   * should use {@link FinalizeWithdrawRollup}.
   */
  FinalizeWithdrawStaker = "unstake:finalize-staker",
  /** Governance.finalizeWithdraw(withdrawalId) — governance path (different contract). */
  FinalizeWithdrawGovernance = "unstake:finalize-governance",
}

export const UnstakeStepTypeName: Record<UnstakeStepType, string> = {
  [UnstakeStepType.InitiateWithdrawRollup]: "Initiate Unstake",
  [UnstakeStepType.InitiateWithdrawStaker]: "Initiate Unstake",
  [UnstakeStepType.InitiateWithdrawGovernance]: "Initiate Governance Withdraw",
  [UnstakeStepType.InitiateWithdrawGovernanceWallet]: "Initiate Governance Withdraw",
  [UnstakeStepType.FinalizeWithdrawRollup]: "Finalize Unstake",
  [UnstakeStepType.FinalizeWithdrawStaker]: "Finalize Unstake",
  [UnstakeStepType.FinalizeWithdrawGovernance]: "Finalize Governance Withdraw",
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

/**
 * Step type for miscellaneous on-chain actions that don't fit the
 * stake/claim/unstake taxonomy — operator vault management, admin tools, etc.
 * Like the unstake path, these are `msg.sender`-bound so they cannot batch via
 * Multicall3 on EOA wallets; they ride the cart purely for unified UX and Safe
 * multisig batching.
 */
export enum ActionStepType {
  /** `ATPNonWithdrawableStaker.moveFundsBackToATP()` — operator moves staker
   *  contract balance back to its ATP. */
  MoveFundsBackToATP = "action:move-funds-back",
  /** `StakingRegistry.registerProvider(admin, count, recipient)` — admin tool. */
  RegisterProvider = "action:register-provider",
  /** `StakingRegistry.addKeysToProvider(providerId, keyStores)` — admin tool. */
  AddKeysToProvider = "action:add-keys",
  /** `ATP.updateStakerOperator(operator)` — operator-management action. */
  UpdateStakerOperator = "action:update-operator",
  /** `ATP.upgradeStaker(version)` — operator-management action. */
  UpgradeStaker = "action:upgrade-staker",
}

export const ActionStepTypeName: Record<ActionStepType, string> = {
  [ActionStepType.MoveFundsBackToATP]: "Move Funds to Vault",
  [ActionStepType.RegisterProvider]: "Register Provider",
  [ActionStepType.AddKeysToProvider]: "Add Keys to Provider",
  [ActionStepType.UpdateStakerOperator]: "Update Operator",
  [ActionStepType.UpgradeStaker]: "Upgrade Staker",
}

export interface ActionMetadata extends BaseMetadata<ActionStepType> {
  /** Target contract for the action (staker / registry / etc.) — for display. */
  contractAddress?: Address
  /** Display-only ATP address for move-funds / upgrade / operator entries. */
  atpAddress?: Address
  /** Provider identifier for admin add-keys / register flows. */
  providerId?: number
  /** Operator address for update-operator entries. */
  operatorAddress?: Address
  /** Staker version for upgrade-staker entries. */
  version?: bigint
}

export interface UnstakeMetadata extends BaseMetadata<UnstakeStepType> {
  /** Which validator / attester the unstake targets. Always captured at
   *  add-time so the cart entry's calldata is deterministic and doesn't
   *  depend on chain state changing between add and execute. */
  attesterAddress?: Address
  /** Recipient address (rollup path); captured at add-time, NOT
   *  `msg.sender` — passes explicitly through calldata. */
  recipient?: Address
  /** Rollup contract for rollup-path entries. */
  rollupAddress?: Address
  /** Staker contract for ATP-staker / governance-path entries. */
  stakerAddress?: Address
  /** Governance contract (used by FinalizeWithdrawGovernance). */
  governanceAddress?: Address
  /** Rollup version for the ATP staker path (the position's stored version). */
  version?: bigint
  /** Amount to unstake (governance path) or display-only stake amount (rollup/staker). */
  amount?: bigint
  /** Withdrawal id used by the governance finalize call. */
  withdrawalId?: bigint
  /** Provider name for cart-row display. */
  providerName?: string | null
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
  | BaseCartItem<"unstake", UnstakeMetadata>
  | BaseCartItem<"action", ActionMetadata>

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
  /** Identity-based queue check by `metadata.stepType` + `stepGroupIdentifier`.
   *  Use this when the underlying calldata could change between renders (e.g.
   *  a refetched rollup version) and you'd otherwise see the queued-state
   *  flicker. Returns true when any cart entry shares that identity. */
  checkStepGroupInQueue: (stepType: string | number, stepGroupIdentifier: string) => boolean
  getTransaction: (id: string) => CartTransaction | undefined
  getTransactionByTx: (transaction: RawTransaction) => CartTransaction | undefined
  isSafe: boolean
  isCartOpen: boolean
  openCart: () => void
  closeCart: () => void
}
