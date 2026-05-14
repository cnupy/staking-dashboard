/**
 * Cart-entry builders for operators claiming their commission. Same primitives
 * as the delegator path (`buildDelegationClaimEntries`), but the trailing
 * warehouse withdraw is wired to the OPERATOR's `providerRewardsRecipient`
 * instead of the connected wallet. That's the only address change required —
 * `Split.distribute` is permissionless and routes commission based on the
 * split's own `recipients` tuple, not on `msg.sender`.
 *
 * Notes:
 *
 *   - `splitData.recipients` must match what the split was created with
 *     (`[providerRewardsRecipient, delegatorBeneficiary]` with allocations
 *     `[providerTakeRate, 10000 - providerTakeRate]`). The Splits contract
 *     verifies the supplied tuple matches a precomputed hash; an incorrect
 *     tuple reverts the call.
 *   - There's no dust threshold here. Even small amounts are real revenue for
 *     an operator and worth a distribute.
 *   - Per (provider, recipient) there's exactly ONE warehouse withdraw at the
 *     end. Multiple providers can share a `providerRewardsRecipient`, so the
 *     caller MUST dedupe by recipient when stitching multi-provider carts.
 */

import {
  ClaimStepType,
  type ClaimMetadata,
  type TransactionDependency,
} from "@/contexts/TransactionCartContextType"
import type { CartTransaction } from "@/contexts/TransactionCartContext"
import {
  buildClaimSequencerRewardsTx,
  buildWarehouseWithdrawEntry,
  type ClaimCartEntry,
} from "@/utils/claimCart"
import { buildDistributeRewardsTx } from "@/hooks/splits/useDistributeRewards"
import { formatTokenAmountFull } from "@/utils/atpFormatters"
import type { Address } from "viem"

export interface OperatorSplitInputs {
  splitContract: Address
  providerRewardsRecipient: Address
  /** When undefined, the distribute step is skipped (we can't rebuild
   *  splitData without the delegator-side recipient). Per-rollup claims and
   *  any pre-existing warehouse balance are still bundled. */
  delegatorBeneficiary?: Address
  providerTakeRate: number
  providerLabel: string
  /** Per-rollup unclaimed `getSequencerRewards(splitContract)` balances. */
  rollupRewardsByRollup: Array<{ rollupAddress: Address; rollupVersion: string; rewards: bigint }>
  /** Current ERC20 balance sitting on the split contract (pre-distribute). */
  splitContractBalance: bigint
  tokenAddress: Address
  decimals: number
  symbol: string
}

export interface OperatorSplitResult {
  entries: ClaimCartEntry[]
  /** `stepGroupIdentifier` of the distribute step for this split, or null when
   *  no work was queued (everything already swept). Pass through to the
   *  caller's warehouse-withdraw dependency graph. */
  distributeGroup: string | null
}

/**
 * One split's claim leg from the operator side: a `claimSequencerRewards`
 * entry per rollup with a non-zero balance, then a single `distribute` to
 * push tokens into the warehouse. The withdraw step is intentionally NOT
 * emitted here — the caller bundles every distribute into one withdraw per
 * `providerRewardsRecipient` via `buildOperatorWarehouseWithdrawEntry`.
 *
 * Skips the whole split if it has no rollup-claimables AND no on-split
 * balance — there's nothing to distribute.
 */
export function buildOperatorSplitEntries(inputs: OperatorSplitInputs): OperatorSplitResult {
  const {
    splitContract,
    providerRewardsRecipient,
    delegatorBeneficiary,
    providerTakeRate,
    providerLabel,
    rollupRewardsByRollup,
    splitContractBalance,
    tokenAddress,
    decimals,
    symbol,
  } = inputs

  const claimables = rollupRewardsByRollup.filter((r) => r.rewards > 0n)
  if (claimables.length === 0 && splitContractBalance === 0n) {
    return { entries: [], distributeGroup: null }
  }

  // Distinct stepGroup namespace from delegator entries (which use
  // `delegation:...`). Lets a wallet that is BOTH delegator and operator
  // queue both legs without the cart's dedupe collapsing one into the other.
  const stepGroup = `operator-commission:${splitContract.toLowerCase()}`
  const claimGroupFor = (r: { rollupAddress: Address }) =>
    `${stepGroup}:${r.rollupAddress.toLowerCase()}`

  const entries: ClaimCartEntry[] = []

  for (const r of claimables) {
    const metadata: ClaimMetadata = {
      stepType: ClaimStepType.SplitClaim,
      stepGroupIdentifier: claimGroupFor(r),
      splitContract,
      rollupAddress: r.rollupAddress,
      rollupVersion: r.rollupVersion,
      amount: r.rewards,
    }
    entries.push({
      type: "claim",
      label: `Claim — Rollup v${r.rollupVersion}`,
      description: `${formatTokenAmountFull(r.rewards, decimals, symbol)} from ${providerLabel}`,
      transaction: buildClaimSequencerRewardsTx(splitContract, r.rollupAddress),
      metadata,
    })
  }

  // Distribute requires the delegator-side recipient to rebuild splitData.
  // When we don't have it (indexer hasn't surfaced an `atp.beneficiary` for
  // this stake, typical for ERC20 wallet delegations), we queue the rollup
  // claims only and bail on the distribute step. The caller's UI should
  // explain this state so the operator knows why the chain isn't fully
  // batched.
  if (!delegatorBeneficiary) {
    return { entries, distributeGroup: null }
  }

  const totalAllocation = 10000n
  const providerAllocation = BigInt(providerTakeRate)
  const userAllocation = totalAllocation - providerAllocation
  const splitData = {
    recipients: [providerRewardsRecipient, delegatorBeneficiary],
    allocations: [providerAllocation, userAllocation],
    totalAllocation,
    distributionIncentive: 0,
  }
  const distributeDependsOn: TransactionDependency<ClaimStepType>[] = claimables.map((r) => ({
    stepType: ClaimStepType.SplitClaim,
    stepGroupIdentifier: claimGroupFor(r),
  }))
  entries.push({
    type: "claim",
    label: `Distribute — ${providerLabel}`,
    description: `Push commission to warehouse`,
    transaction: buildDistributeRewardsTx(
      splitContract,
      splitData,
      tokenAddress,
      // `distributor` parameter — pays the distribution-incentive bounty
      // (currently 0). Setting it to the operator's recipient keeps any
      // future incentive flowing to the same address as the commission.
      providerRewardsRecipient,
    ),
    metadata: {
      stepType: ClaimStepType.SplitDistribute,
      stepGroupIdentifier: stepGroup,
      splitContract,
      tokenAddress,
      dependsOn: distributeDependsOn.length ? distributeDependsOn : undefined,
    },
  })

  return { entries, distributeGroup: stepGroup }
}

/**
 * One warehouse withdraw that drains the operator's commission balance for
 * `providerRewardsRecipient` + `tokenAddress`. Caller is expected to call
 * this once per distinct recipient — see file header.
 */
export function buildOperatorWarehouseWithdrawEntry(inputs: {
  warehouseAddress: Address
  providerRewardsRecipient: Address
  tokenAddress: Address
  /** Every upstream distribute group this withdraw should wait on. */
  dependsOnDistributeGroups: string[]
}): ClaimCartEntry {
  const { warehouseAddress, providerRewardsRecipient, tokenAddress, dependsOnDistributeGroups } = inputs
  // The shared `buildWarehouseWithdrawEntry` only supports a single dep group
  // (it's tailored to the delegator flow's "last distribute" chain). The
  // operator path can have N parallel distributes feeding the same withdraw,
  // so we build the entry inline with the full dep list. We still reuse the
  // raw-tx helper from `claimCart.ts` to keep one source of truth for
  // calldata encoding.
  const base = buildWarehouseWithdrawEntry({
    warehouseAddress,
    beneficiary: providerRewardsRecipient,
    tokenAddress,
    dependsOnDistributeGroup: null,
  })
  return {
    ...base,
    label: "Withdraw commission",
    description: `To ${providerRewardsRecipient.slice(0, 10)}…${providerRewardsRecipient.slice(-8)}`,
    metadata: {
      ...base.metadata,
      stepGroupIdentifier: `operator-warehouse:${warehouseAddress.toLowerCase()}:${providerRewardsRecipient.toLowerCase()}`,
      dependsOn: dependsOnDistributeGroups.map((g) => ({
        stepType: ClaimStepType.SplitDistribute,
        stepGroupIdentifier: g,
      })),
    },
  }
}

/**
 * Convenience: collapse a fully-resolved set of operator splits into the
 * ordered list of cart entries the cart's `addTransaction` expects. Caller
 * passes the warehouse + token addresses (one warehouse per token), this
 * function emits all per-split claims + distributes, then one withdraw per
 * distinct `providerRewardsRecipient`.
 */
export function buildOperatorCommissionEntries(inputs: {
  splits: OperatorSplitInputs[]
  warehouseAddress: Address
  tokenAddress: Address
}): ClaimCartEntry[] {
  const { splits, warehouseAddress, tokenAddress } = inputs
  const entries: ClaimCartEntry[] = []
  const depsByRecipient = new Map<string, string[]>()

  for (const split of splits) {
    const { entries: splitEntries, distributeGroup } = buildOperatorSplitEntries(split)
    entries.push(...splitEntries)
    if (distributeGroup) {
      const key = split.providerRewardsRecipient.toLowerCase()
      const list = depsByRecipient.get(key) ?? []
      list.push(distributeGroup)
      depsByRecipient.set(key, list)
    }
  }

  // One withdraw per distinct recipient — the warehouse is per-(user, token).
  for (const split of splits) {
    const key = split.providerRewardsRecipient.toLowerCase()
    const deps = depsByRecipient.get(key)
    if (!deps || deps.length === 0) continue
    // Mark consumed so multi-provider operators don't get N copies of the
    // same withdraw.
    depsByRecipient.delete(key)
    entries.push(
      buildOperatorWarehouseWithdrawEntry({
        warehouseAddress,
        providerRewardsRecipient: split.providerRewardsRecipient,
        tokenAddress,
        dependsOnDistributeGroups: deps,
      }),
    )
  }

  return entries
}

export type { ClaimCartEntry } from "@/utils/claimCart"
export type OperatorCommissionCartEntry = Omit<Extract<CartTransaction, { type: "claim" }>, "id">
