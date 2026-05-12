import type { Address } from "viem"
import { useAttesterViewBestEffort } from "./useAttesterViewBestEffort"
import { useEjectionThreshold } from "./useEjectionThreshold"
import { useActivationThresholdFormatted } from "./useActivationThresholdFormatted"

export interface StakeHealth {
  effectiveBalance: bigint | undefined
  activationThreshold: bigint | undefined
  ejectionThreshold: bigint | undefined
  healthPercentage: number
  /** Cumulative amount lost from the original activation stake (>= 0). */
  lossAmount: bigint
  /** `lossAmount` as a percentage of `activationThreshold`. 0 when at full stake. */
  lossPercentage: number
  isAtRisk: boolean
  isCritical: boolean
}

/**
 * Hook to calculate stake health for an attester. Returns health percentage,
 * the cumulative loss (raw + percentage of activation threshold), and risk
 * indicators.
 *
 * Health percentage is calculated as:
 * - 100% = effectiveBalance equals activationThreshold (full stake, no slashes)
 * - 0% = effectiveBalance equals or below ejectionThreshold (will be ejected)
 *
 * `lossAmount` / `lossPercentage` capture how much stake has been slashed
 * regardless of the per-slash penalty. The slasher contract sets the penalty
 * (and it changes over time), so we derive the loss purely from on-chain
 * balance rather than estimating a count.
 *
 * Risk levels:
 * - isAtRisk: healthPercentage < 50 (has been slashed significantly)
 * - isCritical: effectiveBalance <= ejectionThreshold (imminent ejection)
 */
export function useStakeHealth(
  attesterAddress: Address | undefined,
  rollupAddress: Address | undefined,
) {
  const {
    effectiveBalance,
    status,
    isLoading: isLoadingAttester,
    error: attesterError,
    refetch: refetchAttester,
  } = useAttesterViewBestEffort(attesterAddress, rollupAddress)

  const { ejectionThreshold, isLoading: isLoadingEjection, error: ejectionError, refetch: refetchEjection } =
    useEjectionThreshold()

  const { activationThreshold, isLoading: isLoadingActivation, error: activationError } =
    useActivationThresholdFormatted()

  const isLoading = isLoadingAttester || isLoadingEjection || isLoadingActivation
  const error = attesterError || ejectionError || activationError

  let healthPercentage = 100
  let lossAmount = 0n
  let lossPercentage = 0
  let isAtRisk = false
  let isCritical = false

  if (effectiveBalance !== undefined && activationThreshold !== undefined && ejectionThreshold !== undefined) {
    // `healthPercentage` is "how much of the cushion between activation and
    // ejection thresholds is left". This drives bar fill + color, since what
    // the user actually cares about is proximity to ejection. The cumulative
    // loss (`lossAmount` / `lossPercentage` below) is surfaced separately as
    // a headline so a small slash isn't visually misread as "near ejection".
    const cushionRange = activationThreshold - ejectionThreshold
    const cushionLeft = effectiveBalance - ejectionThreshold
    if (cushionRange > 0n) {
      healthPercentage = Math.max(0, Math.min(100,
        Number((cushionLeft * 100n) / cushionRange)
      ))
    }

    // Cumulative loss vs the activation threshold. Bigint subtraction with a
    // floor at 0 — effectiveBalance can briefly exceed activation in edge cases.
    if (effectiveBalance < activationThreshold) {
      lossAmount = activationThreshold - effectiveBalance
      if (activationThreshold > 0n) {
        // 10000 scale so 1% loss shows as 1.00 rather than rounding to 1.
        lossPercentage = Number((lossAmount * 10000n) / activationThreshold) / 100
      }
    }

    isAtRisk = healthPercentage < 50
    isCritical = effectiveBalance <= ejectionThreshold
  }

  const refetch = () => {
    refetchAttester()
    refetchEjection()
  }

  return {
    effectiveBalance,
    activationThreshold,
    ejectionThreshold,
    healthPercentage,
    lossAmount,
    lossPercentage,
    isAtRisk,
    isCritical,
    status,
    isLoading,
    error,
    refetch,
  }
}
