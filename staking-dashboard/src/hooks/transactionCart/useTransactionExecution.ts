import { useCallback } from "react"
import type { CartTransaction } from "@/contexts/TransactionCartContext"
import { useAlert } from "@/contexts/AlertContext"
import { useEOAExecution } from "./useEOAExecution"
import { useSafeExecution } from "./useSafeExecution"
import {
  useMulticall3Execution,
  planExecution,
  MULTICALL3_ERROR,
  type ExecutionSegment,
} from "./useMulticall3Execution"
import { useSafeApp } from "../useSafeApp"

interface UseTransactionExecutionProps {
  transactions: CartTransaction[]
  setTransactions: React.Dispatch<React.SetStateAction<CartTransaction[]>>
  setCurrentExecutingId: React.Dispatch<React.SetStateAction<string | null>>
}

/**
 * Cart execution dispatcher.
 *
 * Routing priority:
 *   1. Safe wallets → `useSafeExecution` (single multisig proposal containing
 *      every pending entry, regardless of type).
 *   2. EOA → segment the pending list via `planExecution` and dispatch each
 *      segment in order:
 *        - `multicall` segments  → `useMulticall3Execution` (one wallet
 *          signature per segment, plus internal gas-aware chunking)
 *        - `sequential` segments → `useEOAExecution` (one signature per entry)
 *
 * Mixed carts (claim + stake) split into multiple segments. Failure inside
 * any segment aborts the rest — matching the cart's existing single-path
 * abort-on-failure semantic. Earlier segments that already succeeded stay
 * `completed`; later segments stay `pending` for the user to retry.
 */
export function useTransactionExecution({
  transactions,
  setTransactions,
  setCurrentExecutingId
}: UseTransactionExecutionProps) {
  const { isSafeApp, sdk: safeSDK } = useSafeApp()

  const { showAlert } = useAlert()

  const { executeTransactions: executeEOA } = useEOAExecution({
    setTransactions,
    setCurrentExecutingId
  })

  const { executeTransactions: executeSafe } = useSafeExecution({
    setTransactions
  })

  const { executeTransactions: executeMulticall3 } = useMulticall3Execution({
    setTransactions,
    setCurrentExecutingId,
  })

  /**
   * Run a single segment, with fallback for the multicall path's known
   * pre-flight conditions (chain doesn't have Multicall3, chain mismatch
   * during a switch, account briefly unavailable, ineligibility bug). Those
   * conditions short-circuit by running the segment's entries through the
   * sequential EOA path instead. Anything else (user rejection, post-sign
   * revert) is the multicall path's responsibility to surface; we re-throw
   * so the outer loop aborts.
   */
  const runSegment = useCallback(async (segment: ExecutionSegment) => {
    if (segment.kind === 'sequential') {
      await executeEOA(segment.entries, transactions)
      return
    }
    try {
      await executeMulticall3(segment.entries, transactions)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isRecoverable =
        msg === MULTICALL3_ERROR.NOT_DEPLOYED ||
        msg === MULTICALL3_ERROR.CHAIN_MISMATCH ||
        msg === MULTICALL3_ERROR.NO_ACCOUNT ||
        msg === MULTICALL3_ERROR.DISPATCHER_BUG
      if (isRecoverable) {
        showAlert('info', 'Falling back to one-by-one execution for this segment')
        await executeEOA(segment.entries, transactions)
      } else {
        throw error
      }
    }
  }, [executeEOA, executeMulticall3, transactions, showAlert])

  const executeAll = useCallback(async () => {
    const pendingTransactions = transactions.filter(tx =>
      tx.status === 'pending' || tx.status === undefined
    )

    if (pendingTransactions.length === 0) {
      showAlert("info", "No pending transactions to execute")
      return
    }

    if (isSafeApp && safeSDK) {
      await executeSafe(pendingTransactions, transactions)
      return
    }

    // Segment the pending list; dispatch each segment to its path in order.
    // For homogeneous carts (the common case) this produces exactly one
    // segment and behaves identically to the previous single-path dispatch.
    const segments = planExecution(pendingTransactions)
    for (const segment of segments) {
      await runSegment(segment)
    }

    // Single success toast once every segment completed — the inner hooks
    // intentionally don't emit per-segment "all done" toasts (would spam N
    // identical confirmations on a multi-segment cart).
    showAlert("success", "All transactions executed successfully")
  }, [transactions, isSafeApp, safeSDK, executeSafe, runSegment, showAlert])

  return { executeAll }
}
