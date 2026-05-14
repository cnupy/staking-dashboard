import { useMemo } from "react"
import { useReadContract, useReadContracts } from "wagmi"
import type { Address } from "viem"
import { contracts, getRollupVersions } from "@/contracts"
import { ERC20Abi } from "@/contracts/abis/ERC20"
import { SplitAbi } from "@/contracts/abis/Split"
import { SplitWarehouseAbi } from "@/contracts/abis/SplitWarehouse"
import type { CoinbaseBreakdown } from "@/hooks/rewards/rewardsTypes"

interface UseOperatorOnChainReadsParams {
  splits: Address[]
  recipients: Address[]
  tokenAddress: Address | undefined
}

interface UseOperatorOnChainReadsResult {
  warehouseAddress: Address | undefined
  /** `getSequencerRewards(split)` per rollup, grouped by lower-cased split. */
  rollupRewardsBySplit: Map<string, CoinbaseBreakdown[]>
  /** `ERC20.balanceOf(split)` keyed by lower-cased split. */
  splitBalances: Map<string, bigint>
  /** `SplitsWarehouse.balanceOf(recipient, tokenId)` keyed by lower-cased recipient. */
  warehouseBalances: Map<string, bigint>
  isLoading: boolean
}

/**
 * Unified multicall for the entire operator page. All on-chain reads we need
 * fit into a single `useReadContracts` (which wagmi compiles down to one
 * Multicall3.aggregate3 RPC) instead of the three roundtrips the previous
 * version used (one for rollup rewards, one for split balances, one for
 * warehouse balances). The warehouse address still needs a separate read —
 * we have to ask any one split which warehouse it points at before we can
 * call `balanceOf` on the warehouse.
 *
 * Layout of the multicall (in order):
 *
 *   [0 .. R*S)               — getSequencerRewards(split) per (rollup, split)
 *   [R*S .. R*S + S)         — ERC20.balanceOf(split) per split
 *   [R*S + S .. R*S + S + N) — SplitsWarehouse.balanceOf(recipient, tokenId)
 *
 * Where R = rollup count, S = split count, N = distinct-recipient count.
 */
export function useOperatorOnChainReads(
  params: UseOperatorOnChainReadsParams,
): UseOperatorOnChainReadsResult {
  const { splits, recipients, tokenAddress } = params

  // Resolve the warehouse via any one split's `SPLITS_WAREHOUSE()` view.
  // All splits in this dashboard point at the same warehouse for a given
  // chain, so reading from one is sufficient.
  const anySplit = splits[0]
  const { data: warehouseAddressRaw } = useReadContract({
    address: anySplit,
    abi: SplitAbi,
    functionName: "SPLITS_WAREHOUSE",
    query: { enabled: !!anySplit },
  })
  const warehouseAddress = warehouseAddressRaw as Address | undefined

  // Same ordinal-ising as the existing per-rollup hook.
  const rollups = useMemo(() => {
    const versions = getRollupVersions()
    if (versions.length > 0) {
      return versions.map((v, i) => ({ address: v.address, version: String(i + 1) }))
    }
    return [{ address: contracts.rollup.address, version: undefined as string | undefined }]
  }, [])

  const tokenId = tokenAddress ? BigInt(tokenAddress) : undefined

  // Build the single contracts array. Order matters — we slice by it below.
  const contractsArg = useMemo(() => {
    if (splits.length === 0 || !tokenAddress) return undefined
    const calls: Array<{
      abi: typeof contracts.rollup.abi | typeof ERC20Abi | typeof SplitWarehouseAbi
      address: Address
      functionName: string
      args: readonly unknown[]
    }> = []

    // 1. getSequencerRewards(split) per (rollup, split)
    for (const rollup of rollups) {
      for (const split of splits) {
        calls.push({
          abi: contracts.rollup.abi,
          address: rollup.address,
          functionName: "getSequencerRewards",
          args: [split],
        })
      }
    }

    // 2. ERC20.balanceOf(split) per split
    for (const split of splits) {
      calls.push({
        abi: ERC20Abi,
        address: tokenAddress,
        functionName: "balanceOf",
        args: [split],
      })
    }

    // 3. SplitsWarehouse.balanceOf(recipient, tokenId) per recipient — only
    //    when we know the warehouse + token.
    if (warehouseAddress && tokenId !== undefined) {
      for (const recipient of recipients) {
        calls.push({
          abi: SplitWarehouseAbi,
          address: warehouseAddress,
          functionName: "balanceOf",
          args: [recipient, tokenId],
        })
      }
    }

    return calls
  }, [splits, recipients, rollups, tokenAddress, warehouseAddress, tokenId])

  const { data: rawData, isLoading } = useReadContracts({
    // The cast is necessary because the array of heterogeneous ABIs widens
    // to a union that wagmi's generic infers as `any` — viem still encodes
    // each call against its own ABI correctly at runtime.
    contracts: contractsArg as never,
    query: {
      enabled: !!contractsArg,
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  })
  // wagmi widens the heterogeneous-contracts overload's data type to `never`;
  // reify here once so the slicers below stay readable.
  const data = rawData as
    | Array<{ status: "success"; result: unknown } | { status: "failure"; error: unknown }>
    | undefined

  const rollupRewardsBySplit = useMemo(() => {
    const out = new Map<string, CoinbaseBreakdown[]>()
    if (!data || splits.length === 0) return out
    let cursor = 0
    for (const rollup of rollups) {
      for (const split of splits) {
        const result = data[cursor++]
        const rewards =
          result?.status === "success" && typeof result.result === "bigint" ? result.result : 0n
        const key = split.toLowerCase()
        const list = out.get(key) ?? []
        list.push({
          address: split,
          rewards,
          source: "manual",
          rollupAddress: rollup.address,
          rollupVersion: rollup.version,
        })
        out.set(key, list)
      }
    }
    return out
  }, [data, splits, rollups])

  const splitBalances = useMemo(() => {
    const out = new Map<string, bigint>()
    if (!data || splits.length === 0) return out
    const offset = rollups.length * splits.length
    for (let i = 0; i < splits.length; i++) {
      const result = data[offset + i]
      const value =
        result?.status === "success" && typeof result.result === "bigint" ? result.result : 0n
      out.set(splits[i].toLowerCase(), value)
    }
    return out
  }, [data, splits, rollups])

  const warehouseBalances = useMemo(() => {
    const out = new Map<string, bigint>()
    if (!data || splits.length === 0 || recipients.length === 0) return out
    if (!warehouseAddress || tokenId === undefined) return out
    const offset = rollups.length * splits.length + splits.length
    for (let i = 0; i < recipients.length; i++) {
      const result = data[offset + i]
      const value =
        result?.status === "success" && typeof result.result === "bigint" ? result.result : 0n
      out.set(recipients[i].toLowerCase(), value)
    }
    return out
  }, [data, splits, recipients, rollups, warehouseAddress, tokenId])

  return {
    warehouseAddress,
    rollupRewardsBySplit,
    splitBalances,
    warehouseBalances,
    isLoading,
  }
}
