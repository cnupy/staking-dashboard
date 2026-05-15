/**
 * Cart-entry builders for the unstake / finalize-withdraw flows.
 *
 * Three paths, two phases each:
 *
 *   - Rollup (wallet ERC20 direct stakers)
 *   - Staker (ATP delegations)
 *   - Governance (ATP holders who deposited into governance)
 *
 * None of these are Multicall3-batchable on EOA wallets — `msg.sender`-bound
 * authorisation gates every entry — so they all land in `sequential` segments
 * of the cart's execution plan. Safe wallets still batch them natively, which
 * was the motivation for cart-routing in the first place.
 *
 * All args required to build the tx are captured at add-to-cart time so the
 * encoded calldata is deterministic. Nothing here depends on `msg.sender`
 * resolving to anything in particular.
 */

import { encodeFunctionData, type Address } from "viem"
import {
  UnstakeStepType,
  type RawTransaction,
} from "@/contexts/TransactionCartContextType"
import type { CartTransaction } from "@/contexts/TransactionCartContext"
import { contracts } from "@/contracts"
import { ATPWithdrawableStakerAbi } from "@/contracts/abis/ATPWithdrawableStaker"
import { ATPWithdrawableAndClaimableStakerAbi } from "@/contracts/abis/ATPWithdrawableAndClaimableStaker"

export type UnstakeCartEntry = Omit<Extract<CartTransaction, { type: "unstake" }>, "id">

// ─────────────────────────────────────────────────────────────────────────────
// Rollup path (wallet ERC20 direct stakers)
// ─────────────────────────────────────────────────────────────────────────────

/** `Rollup.initiateWithdraw(attester, recipient)` raw tx. */
export function buildRollupInitiateWithdrawTx(
  rollupAddress: Address,
  attester: Address,
  recipient: Address,
): RawTransaction {
  return {
    to: rollupAddress,
    data: encodeFunctionData({
      abi: contracts.rollup.abi,
      functionName: "initiateWithdraw",
      args: [attester, recipient],
    }),
    value: 0n,
  }
}

/** `Rollup.finalizeWithdraw(attester)` raw tx. */
export function buildRollupFinalizeWithdrawTx(
  rollupAddress: Address,
  attester: Address,
): RawTransaction {
  return {
    to: rollupAddress,
    data: encodeFunctionData({
      abi: contracts.rollup.abi,
      functionName: "finalizeWithdraw",
      args: [attester],
    }),
    value: 0n,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATP staker path (delegations through an ATP)
// ─────────────────────────────────────────────────────────────────────────────

/** `Staker.initiateWithdraw(version, attester)` raw tx. */
export function buildStakerInitiateWithdrawTx(
  stakerAddress: Address,
  version: bigint,
  attester: Address,
): RawTransaction {
  return {
    to: stakerAddress,
    data: encodeFunctionData({
      abi: ATPWithdrawableStakerAbi,
      functionName: "initiateWithdraw",
      args: [version, attester],
    }),
    value: 0n,
  }
}

// NOTE: there is intentionally no `buildStakerFinalizeWithdrawTx`. The
// Staker's `finalizeWithdraw` forwarder internally calls
// `Rollup.finaliseWithdraw` (British spelling) which doesn't exist on
// Rollup, and the tx reverts. Finalize must go direct to the rollup
// via `buildRollupFinalizeWithdrawTx`. See the long-standing comment
// in `useFinalizeWithdraw.ts` for the original incident note.

// ─────────────────────────────────────────────────────────────────────────────
// Governance path (initiate is on the Staker contract, finalize is on Governance)
// ─────────────────────────────────────────────────────────────────────────────

/** `Staker.initiateWithdrawFromGovernance(amount)` raw tx. */
export function buildGovernanceInitiateWithdrawTx(
  stakerAddress: Address,
  amount: bigint,
): RawTransaction {
  return {
    to: stakerAddress,
    data: encodeFunctionData({
      abi: ATPWithdrawableAndClaimableStakerAbi,
      functionName: "initiateWithdrawFromGovernance",
      args: [amount],
    }),
    value: 0n,
  }
}

/**
 * `Governance.initiateWithdraw(to, amount)` raw tx — direct-deposit ERC20
 * holders (no Staker contract in between).
 */
export function buildGovernanceWalletInitiateWithdrawTx(
  to: Address,
  amount: bigint,
): RawTransaction {
  return {
    to: contracts.governance.address,
    data: encodeFunctionData({
      abi: contracts.governance.abi,
      functionName: "initiateWithdraw",
      args: [to, amount],
    }),
    value: 0n,
  }
}

/** `Governance.finalizeWithdraw(withdrawalId)` raw tx. */
export function buildGovernanceFinalizeWithdrawTx(withdrawalId: bigint): RawTransaction {
  return {
    to: contracts.governance.address,
    data: encodeFunctionData({
      abi: contracts.governance.abi,
      functionName: "finalizeWithdraw",
      args: [withdrawalId],
    }),
    value: 0n,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cart-entry builders — wrap a raw tx + metadata into the `Omit<CartTransaction, "id">`
// shape the cart's `addTransaction` expects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-position group identifier, used both for dedupe at the cart level and
 * for any future `dependsOn` wiring. Distinct per attester / contract pair
 * so two positions on the same attester but different rollups don't collide.
 */
function positionGroup(attester: Address, contract: Address): string {
  return `unstake:${attester.toLowerCase()}:${contract.toLowerCase()}`
}

interface RollupUnstakeInputs {
  rollupAddress: Address
  attester: Address
  recipient: Address
  /** Display-only stake amount. */
  amount?: bigint
  providerName?: string | null
}

export function buildRollupInitiateWithdrawEntry(inputs: RollupUnstakeInputs): UnstakeCartEntry {
  const { rollupAddress, attester, recipient, amount, providerName } = inputs
  return {
    type: "unstake",
    label: "Initiate unstake",
    description: providerName ? `From ${providerName}` : undefined,
    transaction: buildRollupInitiateWithdrawTx(rollupAddress, attester, recipient),
    metadata: {
      stepType: UnstakeStepType.InitiateWithdrawRollup,
      stepGroupIdentifier: positionGroup(attester, rollupAddress),
      attesterAddress: attester,
      recipient,
      rollupAddress,
      amount,
      providerName,
    },
  }
}

export function buildRollupFinalizeWithdrawEntry(inputs: Omit<RollupUnstakeInputs, "recipient">): UnstakeCartEntry {
  const { rollupAddress, attester, amount, providerName } = inputs
  return {
    type: "unstake",
    label: "Finalize unstake",
    description: providerName ? `From ${providerName}` : undefined,
    transaction: buildRollupFinalizeWithdrawTx(rollupAddress, attester),
    metadata: {
      stepType: UnstakeStepType.FinalizeWithdrawRollup,
      stepGroupIdentifier: positionGroup(attester, rollupAddress),
      attesterAddress: attester,
      rollupAddress,
      amount,
      providerName,
    },
  }
}

interface StakerUnstakeInputs {
  stakerAddress: Address
  version: bigint
  attester: Address
  amount?: bigint
  providerName?: string | null
}

export function buildStakerInitiateWithdrawEntry(inputs: StakerUnstakeInputs): UnstakeCartEntry {
  const { stakerAddress, version, attester, amount, providerName } = inputs
  return {
    type: "unstake",
    label: "Initiate unstake",
    description: providerName ? `From ${providerName}` : undefined,
    transaction: buildStakerInitiateWithdrawTx(stakerAddress, version, attester),
    metadata: {
      stepType: UnstakeStepType.InitiateWithdrawStaker,
      stepGroupIdentifier: positionGroup(attester, stakerAddress),
      attesterAddress: attester,
      stakerAddress,
      version,
      amount,
      providerName,
    },
  }
}

// NOTE: there is intentionally no `buildStakerFinalizeWithdrawEntry`.
// See the matching note above `buildStakerInitiateWithdrawTx`/around
// where the Staker variant would live: finalize must go direct to the
// rollup. The Staker-forwarded path reverts due to a long-standing
// British-vs-American spelling mismatch in the Staker's `finalizeWithdraw`
// implementation.

interface GovernanceInitiateInputs {
  stakerAddress: Address
  amount: bigint
}

export function buildGovernanceInitiateWithdrawEntry(inputs: GovernanceInitiateInputs): UnstakeCartEntry {
  const { stakerAddress, amount } = inputs
  return {
    type: "unstake",
    label: "Initiate governance withdraw",
    description: `${amount.toString()} (raw)`,
    transaction: buildGovernanceInitiateWithdrawTx(stakerAddress, amount),
    metadata: {
      stepType: UnstakeStepType.InitiateWithdrawGovernance,
      stepGroupIdentifier: `unstake:gov:${stakerAddress.toLowerCase()}:${amount.toString()}`,
      stakerAddress,
      amount,
    },
  }
}

interface GovernanceWalletInitiateInputs {
  to: Address
  amount: bigint
}

export function buildGovernanceWalletInitiateWithdrawEntry(
  inputs: GovernanceWalletInitiateInputs,
): UnstakeCartEntry {
  const { to, amount } = inputs
  return {
    type: "unstake",
    label: "Initiate governance withdraw",
    description: `${amount.toString()} (raw) to ${to.slice(0, 10)}…${to.slice(-8)}`,
    transaction: buildGovernanceWalletInitiateWithdrawTx(to, amount),
    metadata: {
      stepType: UnstakeStepType.InitiateWithdrawGovernanceWallet,
      stepGroupIdentifier: `unstake:gov-wallet:${to.toLowerCase()}:${amount.toString()}`,
      governanceAddress: contracts.governance.address,
      recipient: to,
      amount,
    },
  }
}

interface GovernanceFinalizeInputs {
  withdrawalId: bigint
}

export function buildGovernanceFinalizeWithdrawEntry(inputs: GovernanceFinalizeInputs): UnstakeCartEntry {
  const { withdrawalId } = inputs
  return {
    type: "unstake",
    label: "Finalize governance withdraw",
    description: `Withdrawal #${withdrawalId.toString()}`,
    transaction: buildGovernanceFinalizeWithdrawTx(withdrawalId),
    metadata: {
      stepType: UnstakeStepType.FinalizeWithdrawGovernance,
      stepGroupIdentifier: `unstake:gov:finalize:${withdrawalId.toString()}`,
      governanceAddress: contracts.governance.address,
      withdrawalId,
    },
  }
}
