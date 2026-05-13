import type { Address } from "viem";
import { useInitiateWithdraw } from "@/hooks/staker/useInitiateWithdraw";
import { TooltipIcon } from "@/components/Tooltip";
import { Icon } from "@/components/Icon";
import { SequencerStatus } from "@/hooks/rollup/useSequencerStatus";
import { useTransactionCart } from "@/contexts/TransactionCartContext";
import { getUnlockTimeDisplay } from "@/utils/dateFormatters";
import { MilestoneStatusBadge } from "@/components/MilestoneStatusBadge";
import {
  buildStakerInitiateWithdrawEntry,
  buildRollupFinalizeWithdrawEntry,
} from "@/utils/unstakeCart";

interface WithdrawalActionsProps {
  stakerAddress: Address;
  attesterAddress: Address;
  rollupVersion: bigint;
  rollupAddress: Address;
  status: number | undefined;
  canFinalize: boolean;
  actualUnlockTime?: bigint;
  withdrawalDelayDays?: number;
  onSuccess?: () => void;
  // ATP context for milestone validation
  atpType?: string;
  registryAddress?: Address;
  milestoneId?: bigint;
  providerName?: string | null;
}

/**
 * Initiate / finalize unstake actions. Queues each as an `unstake` cart entry
 * so Safe wallets batch them into a single proposal alongside any claims that
 * happen to be in the same cart. EOA wallets get a sequential prompt per
 * entry (unstake is `msg.sender`-bound and can't ride through Multicall3),
 * which matches the prior immediate-tx UX from the user's perspective but
 * persists across page reloads via the cart's localStorage state.
 */
export const WithdrawalActions = ({
  stakerAddress,
  attesterAddress,
  rollupVersion,
  rollupAddress,
  status,
  canFinalize,
  actualUnlockTime,
  withdrawalDelayDays,
  onSuccess,
  atpType,
  registryAddress,
  milestoneId,
  providerName,
}: WithdrawalActionsProps) => {
  const isExiting = status === SequencerStatus.EXITING;

  // We only consume the milestone-status read from this hook now; the
  // immediate `initiateWithdraw(...)` call is replaced by an `addTransaction`
  // for the cart.
  const { milestoneStatus, isMilestoneLoading, canWithdraw, milestoneBlockError } =
    useInitiateWithdraw(stakerAddress, {
      registryAddress,
      milestoneId,
      atpType,
    });

  const { addTransaction, checkStepGroupInQueue, openCart } = useTransactionCart();

  const isMATP = atpType === "MATP";
  const isMilestoneGated = isMATP && !canWithdraw;

  const canInitiateUnstake =
    (status === SequencerStatus.VALIDATING || status === SequencerStatus.ZOMBIE) &&
    !isMilestoneGated;
  const canFinalizeWithdrawNow = canFinalize && !isMilestoneGated;

  // Pre-build the cart entries used by the click handlers. We do NOT use
  // their raw-calldata signature to detect "already queued" — that flickers
  // when underlying data (rollup version, attester) refetches mid-render and
  // causes duplicate cart entries. Use the stable stepGroupIdentifier from
  // the entry's metadata instead (see `checkStepGroupInQueue`).
  const initiateEntry = buildStakerInitiateWithdrawEntry({
    stakerAddress,
    version: rollupVersion,
    attester: attesterAddress,
    providerName,
  });
  const finalizeEntry = buildRollupFinalizeWithdrawEntry({
    rollupAddress,
    attester: attesterAddress,
    providerName,
  });
  const isInitiateQueued = !!initiateEntry.metadata?.stepType
    && !!initiateEntry.metadata?.stepGroupIdentifier
    && checkStepGroupInQueue(initiateEntry.metadata.stepType, initiateEntry.metadata.stepGroupIdentifier);
  const isFinalizeQueued = !!finalizeEntry.metadata?.stepType
    && !!finalizeEntry.metadata?.stepGroupIdentifier
    && checkStepGroupInQueue(finalizeEntry.metadata.stepType, finalizeEntry.metadata.stepGroupIdentifier);

  const handleInitiateClick = () => {
    if (isInitiateQueued) {
      openCart();
      return;
    }
    addTransaction(initiateEntry, { preventDuplicate: true });
    onSuccess?.();
    openCart();
  };

  const handleFinalizeClick = () => {
    if (isFinalizeQueued) {
      openCart();
      return;
    }
    addTransaction(finalizeEntry, { preventDuplicate: true });
    onSuccess?.();
    openCart();
  };

  const initiateLabel = isInitiateQueued ? "In Batch — Open Cart" : "Add Initiate Unstake";
  const finalizeLabel = isFinalizeQueued ? "In Batch — Open Cart" : "Add Finalize Withdraw";

  return (
    <div className="pt-3 border-t border-parchment/10 space-y-2">
      <div className="flex items-center gap-1">
        <div className="text-xs text-parchment/60 uppercase tracking-wide font-oracle-standard">
          Withdrawal Actions
        </div>
        <TooltipIcon
          content="Queue the initiate / finalize unstake transactions in the batch cart. Safe wallets sign once for the whole batch; EOA wallets sign each entry sequentially."
          size="sm"
          maxWidth="max-w-md"
        />
      </div>

      {isMATP && (
        <div className="mb-2">
          <MilestoneStatusBadge status={milestoneStatus} isLoading={isMilestoneLoading} />
        </div>
      )}

      {milestoneBlockError && (
        <div className="mb-2 p-3 border border-vermillion/40 bg-vermillion/10 rounded">
          <div className="text-xs text-vermillion">{milestoneBlockError}</div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <button
            onClick={handleInitiateClick}
            disabled={!canInitiateUnstake && !isInitiateQueued || isMilestoneLoading}
            className={`w-full py-1.5 px-3 font-oracle-standard font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50 ${
              isInitiateQueued
                ? "bg-aqua/20 border border-aqua/40 text-aqua hover:bg-aqua/30"
                : "bg-aqua text-ink hover:bg-aqua/90"
            }`}
            title={isMilestoneGated ? milestoneBlockError || undefined : undefined}
          >
            {isInitiateQueued ? (
              <span className="flex items-center justify-center gap-1.5">
                <Icon name="shoppingCart" size="sm" />
                {initiateLabel}
              </span>
            ) : (
              initiateLabel
            )}
          </button>
          <div className="flex items-center gap-1 mt-1">
            <TooltipIcon
              content="Starts the unstaking process. Only available when sequencer is Validating or Inactive."
              size="sm"
              maxWidth="max-w-xs"
            />
            <span className="text-[10px] text-parchment/50">
              Only available for Validating/Inactive status
            </span>
          </div>
        </div>

        <div className="flex-1">
          <button
            onClick={handleFinalizeClick}
            disabled={!canFinalizeWithdrawNow && !isFinalizeQueued}
            className={`w-full py-1.5 px-3 font-oracle-standard font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50 ${
              isFinalizeQueued
                ? "bg-chartreuse/20 border border-chartreuse/40 text-chartreuse hover:bg-chartreuse/30"
                : "bg-chartreuse text-ink hover:bg-chartreuse/90"
            }`}
            title={isMilestoneGated ? milestoneBlockError || undefined : undefined}
          >
            {isFinalizeQueued ? (
              <span className="flex items-center justify-center gap-1.5">
                <Icon name="shoppingCart" size="sm" />
                {finalizeLabel}
              </span>
            ) : (
              finalizeLabel
            )}
          </button>
          <div className="flex items-center gap-1 mt-1">
            <TooltipIcon
              content="Completes the withdrawal and returns funds to your Token Vault. Only available after the withdrawal waiting period has passed."
              size="sm"
              maxWidth="max-w-xs"
            />
            <span className="text-[10px] text-parchment/50">
              {getUnlockTimeDisplay({ isExiting, actualUnlockTime, withdrawalDelayDays })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
