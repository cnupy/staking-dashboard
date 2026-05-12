import type { Address } from "viem"
import { useAttesterView } from "./useAttesterView"
import { SequencerStatus } from "./sequencerStatus"
import { contracts } from "@/contracts"

/**
 * Looks up an attester via `getAttesterView` against both the canonical rollup
 * and the delegation's legacy rollup (when different), and returns whichever
 * view recognises the attester (non-NONE status). Covers:
 *
 *   - Active sequencer on canonical rollup with old delegation record — the
 *     legacy view returns NONE; we fall through to canonical.
 *   - Legacy stake mid-withdrawal — canonical returns NONE; we fall through
 *     to legacy so the exit data is still visible.
 *   - Genuinely unregistered — both NONE; we return the canonical view so
 *     callers still get a well-defined result.
 *
 * Used by `useSequencerStatus` and `useStakeHealth` to avoid duplicating the
 * preference logic.
 */
export function useAttesterViewBestEffort(
  attesterAddress: Address | undefined,
  rollupAddress: Address | undefined,
) {
  const canonicalRollup = contracts.rollup.address
  const isLegacyDifferent =
    !!rollupAddress && rollupAddress.toLowerCase() !== canonicalRollup.toLowerCase()

  const canonicalView = useAttesterView(attesterAddress, canonicalRollup)
  const legacyView = useAttesterView(
    attesterAddress,
    isLegacyDifferent ? rollupAddress : undefined,
  )

  const preferred =
    canonicalView.status !== undefined && canonicalView.status !== SequencerStatus.NONE
      ? canonicalView
      : isLegacyDifferent && legacyView.status !== undefined && legacyView.status !== SequencerStatus.NONE
        ? legacyView
        : canonicalView

  return {
    ...preferred,
    isLoading: canonicalView.isLoading || (isLegacyDifferent && legacyView.isLoading),
    error: preferred.error || (isLegacyDifferent ? legacyView.error : undefined),
    refetch: () => {
      canonicalView.refetch()
      if (isLegacyDifferent) legacyView.refetch()
    },
  }
}
