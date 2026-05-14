import { useMemo } from "react"
import { useAccount, useReadContracts } from "wagmi"
import { useQuery } from "@tanstack/react-query"
import type { Address } from "viem"
import { config } from "@/config"
import { contracts } from "@/contracts"

export interface OperatorIdentity {
  providerId: number
  providerAdmin: Address
  providerRewardsRecipient: Address
  providerTakeRate: number
}

interface UseConnectedOperatorIdentitiesResult {
  /** Provider ids where the connected wallet is the registered `providerAdmin`. */
  asAdmin: OperatorIdentity[]
  /** Provider ids where the connected wallet is the configured `providerRewardsRecipient`. */
  asRecipient: OperatorIdentity[]
  /** Union of the two — any provider id the wallet has an operator-side role for. */
  all: OperatorIdentity[]
  isLoading: boolean
  /** True when EITHER the indexer providers list OR the on-chain configs read
   *  failed. Callers should treat an empty `all` paired with `hasError = true`
   *  as "unknown" rather than "definitely not an operator". */
  hasError: boolean
  /** Manual retry hook for the underlying queries. Settles when both the
   *  indexer query and the on-chain configs read have re-attempted. Errors
   *  are surfaced via `hasError` on the next render, so callers can
   *  fire-and-forget the returned promise. */
  refetch: () => Promise<void>
}

interface ApiProviderListItem {
  id: string
  address?: string
}

interface ApiProvidersResponse {
  providers?: ApiProviderListItem[]
}

async function fetchAllProviders(): Promise<ApiProviderListItem[]> {
  const response = await fetch(`${config.apiHost}/api/providers`)
  if (!response.ok) throw new Error(`HTTP error ${response.status}`)
  const data = (await response.json()) as ApiProvidersResponse
  return data.providers ?? []
}

/**
 * Resolve the connected wallet's operator-side identities across all
 * registered providers. The two roles we care about:
 *
 *   - `providerAdmin` — can call admin functions like `addKeysToProvider`.
 *     May NOT receive commission directly.
 *   - `providerRewardsRecipient` — where commission lands in the
 *     SplitsWarehouse after `Split.distribute`. Defaults to `providerAdmin`
 *     at registration but can be rotated independently, so we always trust
 *     the live `providerConfigurations` read over any cached snapshot.
 *
 * The list of `providerId`s comes from the indexer's `/api/providers`
 * snapshot (full history). An earlier version walked `ProviderRegistered`
 * events directly, but the event-fetching hook caps at ~200k blocks and
 * silently dropped older providers — most operators in practice.
 */
export function useConnectedOperatorIdentities(): UseConnectedOperatorIdentitiesResult {
  const { address } = useAccount()

  const {
    data: providersList,
    isLoading: isLoadingProviders,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ["operator-providers-list"],
    queryFn: fetchAllProviders,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  })

  const providerIds = useMemo<number[]>(() => {
    if (!providersList) return []
    return providersList
      .map((p) => Number(p.id))
      .filter((id) => Number.isFinite(id))
      .sort((a, b) => a - b)
  }, [providersList])

  const {
    data: configs,
    isLoading: isLoadingConfigs,
    isError: configsError,
    refetch: refetchConfigs,
  } = useReadContracts({
    contracts: providerIds.map(
      (id) =>
        ({
          abi: contracts.stakingRegistry.abi,
          address: contracts.stakingRegistry.address,
          functionName: "providerConfigurations",
          args: [BigInt(id)],
        }) as const,
    ),
    query: {
      enabled: providerIds.length > 0 && !!address,
      staleTime: 60_000,
      gcTime: 60_000,
    },
  })

  const isLoading = isLoadingProviders || isLoadingConfigs
  const hasError = providersError || configsError
  // Both refetches surface their own outcomes via wagmi/TanStack state; we
  // just need to kick them off in parallel and let the caller `void` the
  // promise. Returning `Promise<void>` rather than swallowing the chain
  // keeps unhandled-rejection diagnostics clean.
  const refetch = async () => {
    await Promise.all([refetchProviders(), refetchConfigs()])
  }

  return useMemo(() => {
    if (!address || !configs) {
      return { asAdmin: [], asRecipient: [], all: [], isLoading, hasError, refetch }
    }
    const connected = address.toLowerCase()
    const asAdmin: OperatorIdentity[] = []
    const asRecipient: OperatorIdentity[] = []
    for (let i = 0; i < providerIds.length; i++) {
      const result = configs[i]
      if (result?.status !== "success" || !result.result) continue
      const [providerAdmin, providerTakeRate, providerRewardsRecipient] =
        result.result as [Address, number | bigint, Address]
      const identity: OperatorIdentity = {
        providerId: providerIds[i],
        providerAdmin,
        providerRewardsRecipient,
        providerTakeRate: Number(providerTakeRate),
      }
      if (providerAdmin.toLowerCase() === connected) asAdmin.push(identity)
      if (providerRewardsRecipient.toLowerCase() === connected) asRecipient.push(identity)
    }

    const allMap = new Map<number, OperatorIdentity>()
    for (const id of [...asAdmin, ...asRecipient]) allMap.set(id.providerId, id)
    return {
      asAdmin,
      asRecipient,
      all: [...allMap.values()].sort((a, b) => a.providerId - b.providerId),
      isLoading,
      hasError,
      refetch,
    }
    // `refetch` closes over the wagmi/query refetch fns; including it in
    // deps would invalidate the memo every render. The memo's content
    // doesn't depend on it — it's a passthrough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, configs, providerIds, isLoading, hasError])
}
