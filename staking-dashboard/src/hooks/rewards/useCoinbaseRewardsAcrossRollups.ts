import { useMemo } from "react"
import { useReadContracts } from "wagmi"
import type { Address } from "viem"
import { contracts, getRollupVersions, type RollupVersion } from "@/contracts"
import type { CoinbaseBreakdown } from "./rewardsTypes"

/**
 * Multicalls `getSequencerRewards(coinbase)` across every rollup version
 * returned by `/api/rollups`. Emits one `CoinbaseBreakdown` per
 * `(coinbase, rollup)` pair so stranded balances on non-canonical rollups
 * surface as their own rows in the UI (and the claim engine can route each
 * claim call to the right rollup contract).
 */
export function useCoinbaseRewardsAcrossRollups(coinbaseAddresses: Address[]) {
  // `getRollupVersions()` returns oldest-first. The raw `version` is a uint256
  // id from the Registry (e.g. "2934756905") which is awful for UI. We replace
  // it with a 1-based ordinal — "1" = genesis rollup, "2" = first upgrade,
  // etc. — and display that everywhere as "Rollup v{ordinal}".
  const rollups = useMemo<Array<{ address: Address; version?: string }>>(() => {
    const versions = getRollupVersions()
    if (versions.length > 0) {
      return versions.map((v: RollupVersion, i) => ({
        address: v.address,
        version: String(i + 1),
      }))
    }
    return [{ address: contracts.rollup.address, version: undefined }]
  }, [])

  const pairs = useMemo(() => {
    const out: Array<{ rollupAddress: Address; rollupVersion?: string; coinbase: Address }> = []
    for (const rollup of rollups) {
      for (const coinbase of coinbaseAddresses) {
        out.push({ rollupAddress: rollup.address, rollupVersion: rollup.version, coinbase })
      }
    }
    return out
  }, [rollups, coinbaseAddresses])

  const { data, isLoading, isError, error, refetch } = useReadContracts({
    contracts:
      pairs.length > 0
        ? pairs.map(
            (p) =>
              ({
                address: p.rollupAddress,
                abi: contracts.rollup.abi,
                functionName: "getSequencerRewards",
                args: [p.coinbase],
              }) as const,
          )
        : undefined,
    query: {
      enabled: pairs.length > 0,
      refetchInterval: 30 * 1000,
    },
  })

  const allCoinbaseBreakdown = useMemo<CoinbaseBreakdown[]>(() => {
    if (pairs.length === 0) return []
    const out: CoinbaseBreakdown[] = []
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]
      const result = data?.[i]
      const rewards =
        result?.status === "success" ? ((result.result as bigint | undefined) ?? 0n) : 0n
      out.push({
        address: pair.coinbase,
        rewards,
        source: "manual",
        rollupAddress: pair.rollupAddress,
        rollupVersion: pair.rollupVersion,
      })
    }
    return out
  }, [data, pairs])

  const coinbaseBreakdown = useMemo(
    () => allCoinbaseBreakdown.filter((item) => item.rewards > 0n),
    [allCoinbaseBreakdown],
  )

  const totalCoinbaseRewards = useMemo(
    () => coinbaseBreakdown.reduce((total, item) => total + item.rewards, 0n),
    [coinbaseBreakdown],
  )

  return {
    allCoinbaseBreakdown,
    coinbaseBreakdown,
    totalCoinbaseRewards,
    isLoading,
    isError,
    error,
    refetch,
  }
}
