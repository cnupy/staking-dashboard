import type { Address } from "viem"
import { useAttesterView } from "./useAttesterView"
import { SequencerStatus } from "./sequencerStatus"
import { contracts } from "@/contracts"

/**
 * Optional indexer-supplied hint about which rollup currently holds the
 * live record. The indexer captures `moveWithRollup` from the originating
 * tx's calldata and bulk-updates `effectiveRollup` whenever the canonical
 * rollup rotates. If the caller has these handy, this hook uses them as
 * the **preferred** probe candidate — saving an RPC roundtrip in the
 * common case. The on-chain probe still runs as a safety net: if it sees a
 * live record on a different rollup than the hint suggested, the probe's
 * answer wins (the chain is authoritative).
 */
export interface AttesterViewHint {
  effectiveRollup: Address
  moveWithRollup: boolean | null
}

/**
 * Looks up an attester via `getAttesterView` against the candidate rollups
 * (canonical, legacy/deposit-time, and an optional indexer hint) and returns
 * whichever view recognises the attester (non-NONE status). Covers:
 *
 *   - Active sequencer on canonical rollup with old delegation record — the
 *     legacy view returns NONE; we fall through to canonical.
 *     This is the `moveWithRollup = true` (auto-migrating) case: the stake
 *     follows the canonical rollup as it upgrades.
 *   - Legacy stake mid-withdrawal — canonical returns NONE; we fall through
 *     to legacy so the exit data is still visible.
 *     This is the `moveWithRollup = false` case: the stake stays on the
 *     rollup it was originally deposited on.
 *   - Genuinely unregistered — both NONE; we return the canonical view so
 *     callers still get a well-defined result.
 *
 * Returns the **effective rollup** the live record was found on, alongside
 * the view data. Callers that need to send writes (unstake, etc.) should
 * use `effectiveRollup` as the target — NOT the indexer-supplied
 * `rollupAddress`, which records where the deposit happened and may
 * disagree with where the stake currently lives.
 *
 * Used by `useSequencerStatus` and `useStakeHealth` to avoid duplicating the
 * preference logic.
 */
export function useAttesterViewBestEffort(
  attesterAddress: Address | undefined,
  rollupAddress: Address | undefined,
  hint?: AttesterViewHint | null,
) {
  const canonicalRollup = contracts.rollup.address
  const isLegacyDifferent =
    !!rollupAddress && rollupAddress.toLowerCase() !== canonicalRollup.toLowerCase()

  // The indexer hint may match canonical or legacy or a third address. Only
  // probe the hint separately when it doesn't coincide with one we'd probe
  // anyway. This keeps the common case to exactly two reads (canonical +
  // legacy) while still supporting unusual hints.
  const hintRollup = hint?.effectiveRollup
  const hintIsCanonical =
    !!hintRollup && hintRollup.toLowerCase() === canonicalRollup.toLowerCase()
  const hintIsLegacy =
    !!hintRollup && !!rollupAddress && hintRollup.toLowerCase() === rollupAddress.toLowerCase()
  const hintNeedsOwnProbe = !!hintRollup && !hintIsCanonical && !hintIsLegacy

  const canonicalView = useAttesterView(attesterAddress, canonicalRollup)
  const legacyView = useAttesterView(
    attesterAddress,
    isLegacyDifferent ? rollupAddress : undefined,
  )
  const hintView = useAttesterView(
    attesterAddress,
    hintNeedsOwnProbe ? hintRollup : undefined,
  )

  const canonicalHasRecord =
    canonicalView.status !== undefined && canonicalView.status !== SequencerStatus.NONE
  const legacyHasRecord =
    isLegacyDifferent &&
    legacyView.status !== undefined &&
    legacyView.status !== SequencerStatus.NONE
  // `hintHasRecord` is gated on `hintNeedsOwnProbe` — by construction it's
  // only true when the hint address differs from both canonical and legacy
  // (i.e. a third probe was actually issued). When the hint coincides with
  // canonical or legacy, the corresponding `*HasRecord` flag already
  // covers it; this variable would be redundant there. Don't widen this
  // without also reworking the resolution order, or you'll double-count
  // the hint coverage.
  const hintHasRecord =
    hintNeedsOwnProbe &&
    hintView.status !== undefined &&
    hintView.status !== SequencerStatus.NONE

  // Resolution preference, from highest to lowest priority:
  //   1. Indexer hint, if its own probe found a record (it's the most
  //      specific signal — captured from on-chain calldata + migration
  //      tracking).
  //   2. Canonical wins when it has a record (covers moveWithRollup=true).
  //   3. Otherwise, legacy if it has a record (covers moveWithRollup=false
  //      or mid-withdrawal on a legacy rollup).
  //   4. Otherwise, fall back to canonical for a well-defined NONE result.
  //
  // The chain is always authoritative: the hint never overrides a probe
  // that found the validator on a different rollup. This keeps the design
  // future-proof against indexer regressions.
  let preferred = canonicalView
  let effectiveRollup: Address = canonicalRollup
  if (hintHasRecord && hintRollup) {
    preferred = hintView
    effectiveRollup = hintRollup
  } else if (canonicalHasRecord) {
    preferred = canonicalView
    effectiveRollup = canonicalRollup
  } else if (legacyHasRecord && rollupAddress) {
    preferred = legacyView
    effectiveRollup = rollupAddress
  } else if (hint && hintRollup && (hintIsCanonical || hintIsLegacy)) {
    // No probe found a record, but the indexer hint coincided with one
    // we already probed. Honour the hint as the "where this stake last
    // lived" answer rather than forcing canonical, so the operator at
    // least sees a stable target. The probe NONE will still gate the
    // unstake button via `useSequencerStatus`.
    //
    // Also align `preferred` with the chosen rollup. Otherwise the
    // returned status/exit/balance would come from the canonicalView
    // probe while `effectiveRollup` points at legacy — a self-
    // inconsistent result. Both views returned NONE in this branch, so
    // the swap is purely cosmetic (loading/error states stay correct),
    // but it keeps the contract "preferred describes effectiveRollup".
    effectiveRollup = hintRollup
    if (hintIsLegacy) {
      preferred = legacyView
    }
  }

  return {
    ...preferred,
    /** The rollup the live record was found on. Use this as the target for
     *  any unstake / withdraw write — see hook docstring. */
    effectiveRollup,
    isLoading:
      canonicalView.isLoading ||
      (isLegacyDifferent && legacyView.isLoading) ||
      (hintNeedsOwnProbe && hintView.isLoading),
    error:
      preferred.error ||
      (isLegacyDifferent ? legacyView.error : undefined) ||
      (hintNeedsOwnProbe ? hintView.error : undefined),
    refetch: () => {
      canonicalView.refetch()
      if (isLegacyDifferent) legacyView.refetch()
      if (hintNeedsOwnProbe) hintView.refetch()
    },
  }
}
