/**
 * Cart-entry builders for miscellaneous on-chain actions that don't fit the
 * stake / claim / unstake taxonomy — operator vault management, admin tools.
 *
 * None of these are Multicall3-batchable on EOA wallets (all are `msg.sender`
 * gated). They ride the cart for unified UX and so Safe multisig users get
 * native batching across mixed action sets.
 */

import { encodeFunctionData, type Address } from "viem"
import {
  ActionStepType,
  type RawTransaction,
} from "@/contexts/TransactionCartContextType"
import type { CartTransaction } from "@/contexts/TransactionCartContext"
import { contracts } from "@/contracts"
import { ATPNonWithdrawableStakerAbi } from "@/contracts/abis/ATPNonWithdrawableStaker"
import { CommonATPAbi } from "@/contracts/abis/ATP"
import { MATPAbi } from "@/contracts/abis/MATP"

export type ActionCartEntry = Omit<Extract<CartTransaction, { type: "action" }>, "id">

// ─────────────────────────────────────────────────────────────────────────────
// Move funds back to ATP (operator action on a staker contract)
// ─────────────────────────────────────────────────────────────────────────────

/** `ATPNonWithdrawableStaker.moveFundsBackToATP()` raw tx. */
export function buildMoveFundsBackToATPTx(stakerAddress: Address): RawTransaction {
  return {
    to: stakerAddress,
    data: encodeFunctionData({
      abi: ATPNonWithdrawableStakerAbi,
      functionName: "moveFundsBackToATP",
    }),
    value: 0n,
  }
}

interface MoveFundsBackToATPInputs {
  stakerAddress: Address
  /** ATP address (display-only — calldata doesn't take it). */
  atpAddress?: Address
  /** Optional ATP sequential number for the cart label, e.g. "Vault #3". */
  atpLabel?: string
}

export function buildMoveFundsBackToATPEntry(inputs: MoveFundsBackToATPInputs): ActionCartEntry {
  const { stakerAddress, atpAddress, atpLabel } = inputs
  return {
    type: "action",
    label: "Move funds to vault",
    description: atpLabel,
    transaction: buildMoveFundsBackToATPTx(stakerAddress),
    metadata: {
      stepType: ActionStepType.MoveFundsBackToATP,
      stepGroupIdentifier: `action:move-funds:${stakerAddress.toLowerCase()}`,
      contractAddress: stakerAddress,
      atpAddress,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: register provider
// ─────────────────────────────────────────────────────────────────────────────

interface RegisterProviderInputs {
  providerAdmin: Address
  /** Default 10 — matches the existing immediate-tx hook. */
  initialKeysAllowance?: number
  rewardRecipient?: Address
}

export function buildRegisterProviderTx(inputs: RegisterProviderInputs): RawTransaction {
  const { providerAdmin, initialKeysAllowance = 10, rewardRecipient = providerAdmin } = inputs
  return {
    to: contracts.stakingRegistry.address,
    data: encodeFunctionData({
      abi: contracts.stakingRegistry.abi,
      functionName: "registerProvider",
      args: [providerAdmin, initialKeysAllowance, rewardRecipient],
    }),
    value: 0n,
  }
}

export function buildRegisterProviderEntry(inputs: RegisterProviderInputs): ActionCartEntry {
  const { providerAdmin } = inputs
  return {
    type: "action",
    label: "Register provider",
    description: `Admin ${providerAdmin.slice(0, 10)}…${providerAdmin.slice(-8)}`,
    transaction: buildRegisterProviderTx(inputs),
    metadata: {
      stepType: ActionStepType.RegisterProvider,
      stepGroupIdentifier: `action:register-provider:${providerAdmin.toLowerCase()}`,
      contractAddress: contracts.stakingRegistry.address,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: add keys to provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keystore shape accepted by `StakingRegistry.addKeysToProvider`. Mirrors the
 * struct expected by the ABI — typed loosely here because each component
 * passes its own attester / signature data.
 */
export interface ProviderKeyStore {
  attester: Address
  publicKeyG1: { x: bigint; y: bigint }
  publicKeyG2: { x0: bigint; x1: bigint; y0: bigint; y1: bigint }
  signature: { x: bigint; y: bigint }
}

interface AddKeysToProviderInputs {
  providerId: number
  keyStores: ProviderKeyStore[]
}

export function buildAddKeysToProviderTx(inputs: AddKeysToProviderInputs): RawTransaction {
  const { providerId, keyStores } = inputs
  return {
    to: contracts.stakingRegistry.address,
    data: encodeFunctionData({
      abi: contracts.stakingRegistry.abi,
      functionName: "addKeysToProvider",
      args: [BigInt(providerId), keyStores],
    }),
    value: 0n,
  }
}

export function buildAddKeysToProviderEntry(inputs: AddKeysToProviderInputs): ActionCartEntry {
  const { providerId, keyStores } = inputs
  const keyCount = keyStores.length
  return {
    type: "action",
    label: "Add keys to provider",
    description: `Provider ${providerId} · ${keyCount} key${keyCount === 1 ? "" : "s"}`,
    transaction: buildAddKeysToProviderTx(inputs),
    metadata: {
      stepType: ActionStepType.AddKeysToProvider,
      stepGroupIdentifier: `action:add-keys:${providerId}:${keyStores
        .map((k) => k.attester.toLowerCase())
        .sort()
        .join(",")}`,
      contractAddress: contracts.stakingRegistry.address,
      providerId,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update staker operator (`ATP.updateStakerOperator(operator)`)
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateStakerOperatorInputs {
  atpAddress: Address
  operator: Address
}

export function buildUpdateStakerOperatorTx(inputs: UpdateStakerOperatorInputs): RawTransaction {
  const { atpAddress, operator } = inputs
  return {
    to: atpAddress,
    data: encodeFunctionData({
      abi: MATPAbi,
      functionName: "updateStakerOperator",
      args: [operator],
    }),
    value: 0n,
  }
}

export function buildUpdateStakerOperatorEntry(inputs: UpdateStakerOperatorInputs): ActionCartEntry {
  const { atpAddress, operator } = inputs
  return {
    type: "action",
    label: "Update operator",
    description: `Set to ${operator.slice(0, 10)}…${operator.slice(-8)}`,
    transaction: buildUpdateStakerOperatorTx(inputs),
    metadata: {
      stepType: ActionStepType.UpdateStakerOperator,
      stepGroupIdentifier: `action:update-operator:${atpAddress.toLowerCase()}`,
      contractAddress: atpAddress,
      atpAddress,
      operatorAddress: operator,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade staker (`ATP.upgradeStaker(version)`)
// ─────────────────────────────────────────────────────────────────────────────

interface UpgradeStakerInputs {
  atpAddress: Address
  version: bigint | number
}

export function buildUpgradeStakerTx(inputs: UpgradeStakerInputs): RawTransaction {
  const { atpAddress, version } = inputs
  return {
    to: atpAddress,
    data: encodeFunctionData({
      abi: CommonATPAbi,
      functionName: "upgradeStaker",
      args: [BigInt(version)],
    }),
    value: 0n,
  }
}

export function buildUpgradeStakerEntry(inputs: UpgradeStakerInputs): ActionCartEntry {
  const { atpAddress, version } = inputs
  const versionBig = BigInt(version)
  return {
    type: "action",
    label: "Upgrade staker",
    description: `To v${versionBig.toString()}`,
    transaction: buildUpgradeStakerTx(inputs),
    metadata: {
      stepType: ActionStepType.UpgradeStaker,
      stepGroupIdentifier: `action:upgrade-staker:${atpAddress.toLowerCase()}`,
      contractAddress: atpAddress,
      atpAddress,
      version: versionBig,
    },
  }
}
