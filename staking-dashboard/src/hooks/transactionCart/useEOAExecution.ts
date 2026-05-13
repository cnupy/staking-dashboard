import { useCallback } from "react"
import { useWalletClient, usePublicClient } from "wagmi"
import type { Address } from "viem"
import type { CartTransaction, TransactionStatus } from "@/contexts/TransactionCartContext"
import { UnstakeStepType } from "@/contexts/TransactionCartContext"
import { isUserRejection } from "@/utils/transactionCart"
import { parseContractError } from "@/utils/parseContractError"
import { useAlert } from "@/contexts/AlertContext"

/**
 * Per-entry execute-time safety checks. Captures invariants that can ONLY be
 * verified once we know which wallet is signing (we don't know that at
 * add-to-cart time, and cart entries persist across page reloads / wallet
 * disconnects via localStorage).
 *
 * Returning `{ ok: false }` causes the executor to mark the entry as failed
 * with the supplied reason — no signature ever leaves the wallet.
 */
function verifyEntryBeforeSend(
  tx: CartTransaction,
  walletAddress: Address,
): { ok: true } | { ok: false; reason: string } {
  if (
    tx.type === "unstake" &&
    tx.metadata?.stepType === UnstakeStepType.InitiateWithdrawGovernanceWallet
  ) {
    // `Governance.initiateWithdraw(to, amount)` debits `msg.sender`'s
    // governance balance and routes the eventual withdraw to `to`. If the
    // entry was queued under wallet A and the user later executes from
    // wallet B, B would lose funds to A. Block.
    const queuedRecipient = tx.metadata.recipient
    if (!queuedRecipient || queuedRecipient.toLowerCase() !== walletAddress.toLowerCase()) {
      return {
        ok: false,
        reason:
          `Recipient address baked into this entry (${queuedRecipient ?? "missing"}) ` +
          `does not match the connected wallet (${walletAddress}). Remove this entry ` +
          `and re-queue it from the currently connected wallet.`,
      }
    }
  }
  return { ok: true }
}

interface UseEOAExecutionProps {
  setTransactions: React.Dispatch<React.SetStateAction<CartTransaction[]>>
  setCurrentExecutingId: React.Dispatch<React.SetStateAction<string | null>>
}

/**
 * Hook for executing transactions with EOA wallets (sequential)
 */
export function useEOAExecution({
  setTransactions,
  setCurrentExecutingId
}: UseEOAExecutionProps) {
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { showAlert } = useAlert()

  const executeTransactions = useCallback(async (pendingTransactions: CartTransaction[], allTransactions: CartTransaction[]) => {
    if (!walletClient || !publicClient) return

    // Check if there are any transactions currently being tracked
    const hasExecutingTx = allTransactions.some(tx => tx.status === 'executing' && tx.txHash)
    if (hasExecutingTx) {
      showAlert("info", "Please wait for the current transaction to complete")
      return
    }

    const signerAddress = walletClient.account?.address
    if (!signerAddress) {
      showAlert("error", "Wallet account not available")
      return
    }

    for (const tx of pendingTransactions) {
      setCurrentExecutingId(tx.id)

      // Per-entry execute-time safety checks (e.g. wallet-governance
      // recipient must match the signing wallet — see comment in
      // verifyEntryBeforeSend for the fund-routing risk this blocks).
      const safety = verifyEntryBeforeSend(tx, signerAddress)
      if (!safety.ok) {
        setTransactions(prev => prev.map(t =>
          t.id === tx.id
            ? { ...t, status: 'failed' as TransactionStatus, error: safety.reason }
            : t
        ))
        throw new Error(safety.reason)
      }

      try {
        // Mark as executing
        setTransactions(prev => prev.map(t =>
          t.id === tx.id ? { ...t, status: 'executing' as TransactionStatus } : t
        ))

        let hash: `0x${string}`

        if (tx.txHash) {
          hash = tx.txHash as `0x${string}`
        } else {
          // Send transaction using raw transaction data
          hash = await walletClient.sendTransaction({
            to: tx.transaction.to,
            data: tx.transaction.data,
            value: tx.transaction.value,
          })

          // Store hash immediately after sending (before waiting for receipt)
          setTransactions(prev => prev.map(t =>
            t.id === tx.id ? { ...t, txHash: hash } : t
          ))
        }

        // Wait for confirmation
        await publicClient.waitForTransactionReceipt({ hash })

        // Mark as completed with transaction hash
        setTransactions(prev => prev.map(t =>
          t.id === tx.id
            ? { ...t, status: 'completed' as TransactionStatus, txHash: hash }
            : t
        ))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'

        if (isUserRejection(errorMessage)) {
          // Reset to pending if user rejected
          setTransactions(prev => prev.map(t =>
            t.id === tx.id ? { ...t, status: 'pending' as TransactionStatus } : t
          ))
          throw new Error(`User rejected transaction: "${tx.label}"`)
        } else {
          // Normalise known contract error selectors to plain English so the
          // cart panel surfaces "Exit delay has not passed yet" instead of
          // raw `0xef566ee0`. Unknown errors pass through unchanged.
          const friendlyError = parseContractError(errorMessage)
          setTransactions(prev => prev.map(t =>
            t.id === tx.id
              ? { ...t, status: 'failed' as TransactionStatus, error: friendlyError }
              : t
          ))
          throw error
        }
      }
    }

    // Note: the success toast for "all done" is fired by the dispatcher
    // (`useTransactionExecution.executeAll`) once ALL segments succeed —
    // not here per-segment. Otherwise a multi-segment cart would emit N
    // identical "All transactions executed successfully" toasts.
  }, [walletClient, publicClient, setTransactions, setCurrentExecutingId, showAlert])

  return { executeTransactions }
}
