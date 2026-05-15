import { useMemo } from "react"
import { useReadContract } from "wagmi"
import type { Address } from "viem"
import { contracts, getRollupVersions } from "@/contracts"

/**
 * Resolve the on-chain `getVersion()` for a specific rollup address.
 *
 * For ATP-delegated unstake flows we need the rollup version of the
 * rollup that *currently* holds the stake (see `useAttesterViewBestEffort`
 * — `effectiveRollup`), NOT the canonical rollup's version. Passing the
 * wrong version into `Staker.initiateWithdraw(version, attester)` makes the
 * Staker route to the wrong rollup and the call reverts.
 *
 * Fast path: the indexer's `/api/rollups` list contains the on-chain
 * version per rollup (a uint256 string assigned by the Registry), so we
 * try a synchronous lookup against the cached list first. Falls back to
 * `Rollup.getVersion()` if the address isn't in the cache (e.g., the
 * indexer hasn't surfaced it yet, or it's a brand-new rollup the user is
 * interacting with before `/api/rollups` refreshes).
 *
 * Flicker note: when the cache misses on first render, this hook returns
 * `{ version: undefined, isLoading: true }` until the RPC settles. If the
 * cache hydrates between renders (e.g., `/api/rollups` arrives), the
 * `useReadContract` enabled flag flips to `false` and we return the
 * cached version instead — callers see a brief `undefined → bigint`
 * transition. Downstream `useEffect`s that act on `version` should be
 * keyed on it so they re-run once it materialises; we never return a
 * stale/wrong version, only "not yet known".
 */
export function useRollupVersionFor(rollupAddress: Address | undefined): {
  version: bigint | undefined
  isLoading: boolean
} {
  const cachedVersion = useMemo<bigint | undefined>(() => {
    if (!rollupAddress) return undefined
    const target = rollupAddress.toLowerCase()
    const hit = getRollupVersions().find((v) => v.address.toLowerCase() === target)
    if (!hit) return undefined
    try {
      return BigInt(hit.version)
    } catch {
      // The schema in `contracts/index.ts` validates version-as-string at
      // ingest, so BigInt parse failure here would be a schema regression.
      // Defensive: fall through to on-chain read rather than blow up.
      return undefined
    }
  }, [rollupAddress])

  // Only fire the on-chain read when the cache miss matters: caller has a
  // rollup address but we couldn't resolve a version locally.
  const { data, isLoading } = useReadContract({
    address: rollupAddress,
    abi: contracts.rollup.abi,
    functionName: "getVersion",
    query: {
      enabled: !!rollupAddress && cachedVersion === undefined,
      staleTime: Infinity,
      gcTime: Infinity,
    },
  })

  return {
    version: cachedVersion ?? (data as bigint | undefined),
    isLoading: cachedVersion === undefined && isLoading,
  }
}
