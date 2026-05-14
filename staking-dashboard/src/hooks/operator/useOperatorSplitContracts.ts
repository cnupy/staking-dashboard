import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { isAddressEqual, type Address } from "viem"
import { config } from "@/config"
import type { OperatorIdentity } from "./useConnectedOperatorIdentities"

/**
 * One split contract that routes commission to a particular provider. The
 * delegator-side beneficiary is captured at stake time and IS required to
 * rebuild the `splitData.recipients` tuple for a distribute call — but it is
 * NOT required to merely read what's accumulating on the split. If the
 * indexer doesn't expose a beneficiary for a particular stake (currently
 * ERC20 wallet delegations come through without an `atp` object), we still
 * surface the split so its rollup balances are visible; the distribute step
 * is gated separately.
 */
export interface OperatorSplitContract {
  splitContract: Address
  /** Provider id this split is configured against. */
  providerId: number
  /** The provider's configured rewards recipient at the time we read it. */
  providerRewardsRecipient: Address
  providerTakeRate: number
  /** The delegator-side recipient stored on the split, when the indexer
   *  surfaces it. Distribute calls are skipped for splits where this is
   *  undefined. */
  delegatorBeneficiary?: Address
  /** Display label sourced from the indexer's provider name (or id fallback). */
  providerLabel: string
  /** Indexer source — useful for debugging "why is THIS split here" UX. */
  source: "atp-delegation" | "erc20-delegation" | "unknown"
}

interface ProviderStakeRow {
  splitContractAddress?: string
  stakerAddress?: string
  /** Direct beneficiary field from the indexer (added Nov 2026). For ATP
   *  delegations this is the joined ATP beneficiary; for ERC20 wallet
   *  delegations the indexer fills it with the staker's wallet. */
  beneficiary?: string | null
  attesterAddress?: string
  rollupAddress?: string
  atpAddress?: string
  source?: "atp" | "erc20"
  /** Legacy nested shape; kept as a fallback while older indexer builds are
   *  still in rotation. Will go away once every env is past the join fix. */
  atp?: { beneficiary?: string } | null
}

interface ProviderDetailResponse {
  id: string
  name?: string
  stakes?: ProviderStakeRow[]
  // Some indexer responses split ATP and ERC20 delegations into separate
  // arrays — accept both shapes so we don't silently miss either.
  erc20Stakes?: ProviderStakeRow[]
  erc20DelegationBreakdown?: ProviderStakeRow[]
}

async function fetchProviderDetail(providerId: number): Promise<ProviderDetailResponse> {
  const response = await fetch(`${config.apiHost}/api/providers/${providerId}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch provider ${providerId}: ${response.status}`)
  }
  return response.json()
}

/**
 * Collect every split contract that pays the connected operator across the
 * supplied identities. One row per `(splitContract, providerId)` pair —
 * different providers can in theory share a split address (they don't in
 * practice, but it's the deduplication key the cart will eventually need).
 *
 * Filter philosophy: discover broadly, gate narrowly. We surface every split
 * with a non-zero address so the user can SEE rollup-side rewards
 * accumulating. The distribute step inspects `delegatorBeneficiary` per-row
 * and skips entries that don't have one rather than dropping the whole row.
 */
export function useOperatorSplitContracts(identities: OperatorIdentity[]) {
  const queries = useQueries({
    queries: identities.map((identity) => ({
      queryKey: ["operator-provider-detail", identity.providerId],
      queryFn: () => fetchProviderDetail(identity.providerId),
      staleTime: 60_000,
      gcTime: 5 * 60_000,
    })),
  })

  const isLoading = queries.some((q) => q.isLoading)
  const errors = queries.map((q) => q.error).filter(Boolean)

  const splitContracts = useMemo<OperatorSplitContract[]>(() => {
    const out: OperatorSplitContract[] = []
    const seen = new Set<string>()
    for (let i = 0; i < identities.length; i++) {
      const identity = identities[i]
      const data = queries[i]?.data
      if (!data) continue
      const label = data.name?.trim() || `Provider ${identity.providerId}`

      // Walk every plausible stake bucket the indexer might use.
      const buckets: Array<{ rows: ProviderStakeRow[] | undefined; source: OperatorSplitContract["source"] }> = [
        { rows: data.stakes, source: "atp-delegation" },
        { rows: data.erc20Stakes, source: "erc20-delegation" },
        { rows: data.erc20DelegationBreakdown, source: "erc20-delegation" },
      ]

      for (const { rows, source } of buckets) {
        if (!rows) continue
        for (const stake of rows) {
          const splitAddress = stake.splitContractAddress as Address | undefined
          if (!splitAddress) continue

          // Resolve the delegator beneficiary in this preference order:
          //   1. The top-level `beneficiary` field added by the indexer's
          //      provider/details JOIN (post-fix).
          //   2. The legacy nested `atp.beneficiary` field (transitional).
          //   3. `stakerAddress` when the indexer marks the row as ERC20 —
          //      for wallet delegations the staker IS the beneficiary.
          let beneficiary: Address | undefined
          if (stake.beneficiary) {
            beneficiary = stake.beneficiary as Address
          } else if (stake.atp?.beneficiary) {
            beneficiary = stake.atp.beneficiary as Address
          } else if ((stake.source === "erc20" || source === "erc20-delegation") && stake.stakerAddress) {
            beneficiary = stake.stakerAddress as Address
          }

          const key = `${identity.providerId}:${splitAddress.toLowerCase()}`
          if (seen.has(key)) continue
          seen.add(key)

          // Skip degenerate self-splits (operator == delegator).
          if (beneficiary && isAddressEqual(splitAddress, beneficiary)) continue

          // Source comes straight from the indexer when provided; otherwise
          // fall back to the bucket the row was found in.
          const inferredSource: OperatorSplitContract["source"] =
            stake.source === "atp"
              ? "atp-delegation"
              : stake.source === "erc20"
                ? "erc20-delegation"
                : source

          out.push({
            splitContract: splitAddress,
            providerId: identity.providerId,
            providerRewardsRecipient: identity.providerRewardsRecipient,
            providerTakeRate: identity.providerTakeRate,
            delegatorBeneficiary: beneficiary,
            providerLabel: label,
            source: inferredSource,
          })
        }
      }
    }
    return out
  }, [identities, queries])

  return { splitContracts, isLoading, errors }
}
