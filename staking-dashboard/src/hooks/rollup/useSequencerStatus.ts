import type { Address } from "viem";
import { useBlock } from "wagmi";
import { useAttesterViewBestEffort } from "./useAttesterViewBestEffort";
import { useGovernanceWithdrawal } from "../governance/useGovernanceWithdrawal";
import { SequencerStatus, getStatusLabel } from "./sequencerStatus";

// Re-export so existing `from "@/hooks/rollup/useSequencerStatus"` imports
// across the codebase keep working without churn.
export { SequencerStatus, getStatusLabel };

/**
 * Hook to get sequencer status information. Delegates the
 * canonical-vs-legacy-rollup lookup to `useAttesterViewBestEffort` so the
 * same preference logic doesn't drift between this hook and `useStakeHealth`.
 *
 * @param sequencerAddress - The address of the sequencer
 * @param rollupAddress - The delegation's original rollup. May be undefined
 *                        while the caller's data is still loading.
 */
export function useSequencerStatus(
  sequencerAddress: Address | undefined,
  rollupAddress: Address | undefined,
) {
  const { status, effectiveBalance, exit, isLoading, error, refetch } =
    useAttesterViewBestEffort(sequencerAddress, rollupAddress);

  // Query the governance withdrawal to get the REAL unlock time
  const { withdrawal, isLoading: isLoadingWithdrawal } = useGovernanceWithdrawal(exit?.withdrawalId);

  // ANVIL FIX: Use blockchain timestamp instead of Date.now() for local testing
  // When using anvil with time manipulation (anvil_increaseTime), Date.now() returns
  // real system time while the blockchain has a different timestamp. This causes
  // canFinalize to be false even when the exit delay has passed on-chain.
  // In production, blockchain time ~= real time so this doesn't matter.
  const { data: block } = useBlock({ watch: true });
  const blockTimestamp = block?.timestamp ?? BigInt(Math.floor(Date.now() / 1000));

  const statusLabel = getStatusLabel(status);
  const isActive = status === SequencerStatus.VALIDATING;
  const isZombie = status === SequencerStatus.ZOMBIE;
  const isExiting = status === SequencerStatus.EXITING;

  // The REAL unlock time is the MAX of:
  // 1. Rollup's exitableAt (currently 4 days, but could be higher in future)
  // 2. Governance's withdrawal.unlocksAt (14.6 days)
  // Both must be available to calculate the actual unlock time
  const actualUnlockTime =
    exit && withdrawal
      ? (exit.exitableAt > withdrawal.unlocksAt ? exit.exitableAt : withdrawal.unlocksAt)
      : undefined;

  // Check if withdrawal can be finalized using the REAL unlock time
  const canFinalize = !!(
    isExiting &&
    actualUnlockTime &&
    blockTimestamp >= actualUnlockTime
  );

  return {
    status,
    statusLabel,
    effectiveBalance,
    exit,
    withdrawal,
    actualUnlockTime,
    isActive,
    isZombie,
    isExiting,
    canFinalize,
    isLoading: isLoading || isLoadingWithdrawal,
    error,
    refetch,
  };
}
