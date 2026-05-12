import { useCallback } from "react"
import { useWalletClient, usePublicClient } from "wagmi"
import { encodeFunctionData, type Address, type Hex } from "viem"
import type { CartTransaction, TransactionStatus } from "@/contexts/TransactionCartContext"
import { Multicall3Abi, MULTICALL3_ADDRESS } from "@/contracts/abis/Multicall3"
import { isUserRejection } from "@/utils/transactionCart"
import { parseContractError } from "@/utils/parseContractError"
import { useAlert } from "@/contexts/AlertContext"

/**
 * Batched-execution path that routes the whole pending-cart through a single
 * `Multicall3.aggregate3` transaction. Replaces N wallet prompts with 1 for
 * eligible carts.
 *
 * Eligibility: see `isMulticall3Eligible`. The short version is "every entry
 * is a permissionless claim leg with `value: 0n`". Anything else (stake
 * flows, approvals, msg.sender-bound writes) falls through to the sequential
 * EOA path in the dispatcher.
 *
 * Failure model: `allowFailure: false` on every inner call. Any inner revert
 * reverts the whole tx — same all-or-nothing semantic the cart's sequential
 * path already has after our `abort on first failure` change. On revert
 * every queued entry is marked `failed` (we lose per-entry attribution; the
 * pre-flight simulation in `simulateBatch` exists to surface the reason
 * BEFORE the user signs, so a real on-chain revert here means state changed
 * between simulate and send).
 */

interface UseMulticall3ExecutionProps {
  setTransactions: React.Dispatch<React.SetStateAction<CartTransaction[]>>
  setCurrentExecutingId: React.Dispatch<React.SetStateAction<string | null>>
}

/**
 * Hard upper bound on the number of inner calls we'll consider for batching
 * in a SINGLE multicall before chunking. Acts as a sanity bound on cart size;
 * the actual per-tx size is gas-driven (see `BLOCK_GAS_FRACTION` below).
 *
 * Bumped from 64 to 256 to accommodate operator-side carts where one operator
 * may aggregate dozens of delegators × multiple rollups; the gas-aware chunker
 * splits the work safely regardless.
 */
const MAX_BATCH_SIZE = 256

/**
 * Fraction of the chain's current block gas limit we're willing to fill in a
 * single multicall, as a percentage. 75 % leaves headroom for block-fill
 * variance and for an estimation that nudges slightly higher when included on
 * chain. Tune per chain if needed — the value is computed against the LIVE
 * block gas limit, so it self-adjusts as chains raise their limits.
 */
const BLOCK_GAS_FRACTION_PCT = 75n

/**
 * Sentinel error messages emitted by the eligibility / pre-flight checks.
 * Exported so the dispatcher can match them via `=== ` instead of `.includes()`
 * string-matching — a refactor that changes the wording can't silently break
 * the fallback path.
 */
export const MULTICALL3_ERROR = {
  NOT_DEPLOYED: 'Multicall3 not deployed on this chain',
  DISPATCHER_BUG: 'useMulticall3Execution invoked with ineligible cart — dispatcher bug',
  CHAIN_MISMATCH: 'Wallet and read clients are on different chains',
  NO_ACCOUNT: 'No wallet account available',
} as const

/**
 * Per-entry eligibility predicate. An entry can ride through Multicall3 only
 * when it's a permissionless / explicit-arg write (the claim flow) with no
 * value transfer. Stake flows depend on `msg.sender` (allowances, ownership)
 * and would break with Multicall3 as the caller.
 */
export function isEntryMulticall3Eligible(tx: CartTransaction): boolean {
  return tx.type === 'claim' && tx.transaction.value === 0n
}

/**
 * Whole-cart eligibility check, kept for the dispatcher's "is the whole
 * pending set batchable" path. With the segmenter below this is now mostly
 * informational — the dispatcher iterates segments instead of branching on
 * one global flag. Retained because the cart UI still calls it for the
 * eligible-but-no-mix happy path detection.
 *
 *   1. Every entry must pass `isEntryMulticall3Eligible`.
 *   2. Batch size > 1 (single-entry carts don't benefit from wrapping).
 *   3. Batch size <= MAX_BATCH_SIZE (defensive bound; the gas-aware chunker
 *      handles real sizing, but capping here prevents pathological carts
 *      from queuing endless RPC estimations).
 */
export function isMulticall3Eligible(pendingTransactions: CartTransaction[]): boolean {
  if (pendingTransactions.length <= 1) return false
  if (pendingTransactions.length > MAX_BATCH_SIZE) return false
  return pendingTransactions.every(isEntryMulticall3Eligible)
}

/**
 * An ordered plan for executing a pending cart, made of one-or-more segments.
 * Each segment carries the entries that will be dispatched together to a
 * single execution path:
 *
 *   - `multicall` segments hold ≥2 contiguous eligible entries that will
 *     batch into one `Multicall3.aggregate3` transaction (or several chunks
 *     thereof if gas demands).
 *   - `sequential` segments hold one entry (or a single eligible entry that
 *     can't usefully batch by itself) and run via `useEOAExecution` one tx
 *     per signature.
 *
 * Segments preserve the cart's array order, so the cart's existing
 * `dependsOn` validation (which enforces "dep must be before dependent in
 * the cart") stays correct under segmentation.
 */
export type ExecutionSegment =
  | { kind: 'multicall'; entries: CartTransaction[] }
  | { kind: 'sequential'; entries: CartTransaction[] }

/**
 * Walk the pending cart in order and produce execution segments. Two
 * strategies, in priority order:
 *
 *   1. **Reorder + collapse** (preferred). Stable-partition the entries into
 *      eligibles-first / ineligibles-second. If that ordering still respects
 *      every entry's `dependsOn` graph (i.e., no entry's resolved dep ends up
 *      AFTER it in the partitioned order), use it: one multicall segment for
 *      all eligibles (if ≥2), then one sequential segment per ineligible.
 *      This maximises batching — a cart like `[stake, claim, stake, claim]`
 *      becomes `[multicall(claim, claim), seq(stake), seq(stake)]`, 3 sigs
 *      instead of 4.
 *
 *   2. **Contiguous fallback**. If the partition would break a dependency
 *      (rare for current cart entry types — claims and stakes don't
 *      cross-depend — but defensive in case future flows introduce cross-
 *      type deps), fall back to in-order contiguous segmentation. Eligible
 *      runs that already sit next to each other still get batched; runs
 *      split by an ineligible become separate segments.
 *
 * Either way the resulting plan respects deps: in the partition case by
 * validation, in the contiguous case by construction (we preserve the
 * caller's order, which the cart's `dependsOn` validator has already
 * enforced).
 */
export function planExecution(pendingTransactions: CartTransaction[]): ExecutionSegment[] {
  if (pendingTransactions.length === 0) return []

  // 1. Stable partition.
  const eligibles: CartTransaction[] = []
  const ineligibles: CartTransaction[] = []
  for (const tx of pendingTransactions) {
    if (isEntryMulticall3Eligible(tx)) eligibles.push(tx)
    else ineligibles.push(tx)
  }
  const partitioned = [...eligibles, ...ineligibles]

  if (preservesDependencies(partitioned)) {
    return buildSegmentsFromPartition(eligibles, ineligibles)
  }

  // 2. Contiguous fallback (preserves caller order exactly).
  return buildContiguousSegments(pendingTransactions)
}

/**
 * Resolve an entry's declared dependencies by matching on `stepType` +
 * `stepGroupIdentifier`. Mirror of the cart's runtime resolver (which lives
 * in `TransactionCartContext` and isn't exported); kept identical so the
 * segmenter's dep-safety check matches what the cart's `executeAll`
 * validator will accept.
 */
function resolveDependencies(
  tx: CartTransaction,
  pool: CartTransaction[],
): CartTransaction[] {
  const metadata = tx.metadata
  if (!metadata || !('dependsOn' in metadata) || !metadata.dependsOn || metadata.dependsOn.length === 0) {
    return []
  }
  return metadata.dependsOn
    .map((dep) =>
      pool.find((candidate) => {
        const meta = candidate.metadata
        return !!meta && 'stepType' in meta && 'stepGroupIdentifier' in meta &&
          meta.stepType === dep.stepType &&
          meta.stepGroupIdentifier === dep.stepGroupIdentifier
      }),
    )
    .filter((dep): dep is CartTransaction => dep !== undefined)
}

/**
 * Validate that every entry's resolved dependencies come BEFORE it in the
 * supplied order. This is what the cart's `executeAll` validator enforces,
 * and what the dispatcher needs in order to safely run segments in plan
 * order.
 */
function preservesDependencies(ordered: CartTransaction[]): boolean {
  for (let i = 0; i < ordered.length; i++) {
    const deps = resolveDependencies(ordered[i], ordered)
    for (const dep of deps) {
      const depIdx = ordered.findIndex((t) => t.id === dep.id)
      if (depIdx < 0 || depIdx > i) return false
    }
  }
  return true
}

function buildSegmentsFromPartition(
  eligibles: CartTransaction[],
  ineligibles: CartTransaction[],
): ExecutionSegment[] {
  const segments: ExecutionSegment[] = []
  if (eligibles.length >= 2) {
    segments.push({ kind: 'multicall', entries: eligibles })
  } else if (eligibles.length === 1) {
    segments.push({ kind: 'sequential', entries: eligibles })
  }
  for (const tx of ineligibles) {
    segments.push({ kind: 'sequential', entries: [tx] })
  }
  return segments
}

function buildContiguousSegments(pendingTransactions: CartTransaction[]): ExecutionSegment[] {
  const segments: ExecutionSegment[] = []
  let batch: CartTransaction[] = []

  const flushBatch = () => {
    if (batch.length >= 2) {
      segments.push({ kind: 'multicall', entries: batch })
    } else if (batch.length === 1) {
      // Single eligible entry by itself — not worth wrapping in Multicall3
      // (the wrapper overhead saves no signatures).
      segments.push({ kind: 'sequential', entries: batch })
    }
    batch = []
  }

  for (const tx of pendingTransactions) {
    if (isEntryMulticall3Eligible(tx)) {
      batch.push(tx)
    } else {
      flushBatch()
      segments.push({ kind: 'sequential', entries: [tx] })
    }
  }
  flushBatch()

  return segments
}

/**
 * Build the `aggregate3` calldata. `allowFailure: false` so a revert anywhere
 * inside reverts the whole tx (matches the cart's existing abort-on-failure
 * semantic, and keeps the cart's `dependsOn` chain meaningful — a downstream
 * call can't fire when its upstream reverted).
 */
function buildAggregateCalldata(pendingTransactions: CartTransaction[]): Hex {
  const calls = pendingTransactions.map((tx) => ({
    target: tx.transaction.to,
    allowFailure: false,
    callData: tx.transaction.data,
  }))
  return encodeFunctionData({
    abi: Multicall3Abi,
    functionName: 'aggregate3',
    args: [calls],
  })
}

export function useMulticall3Execution({
  setTransactions,
  setCurrentExecutingId,
}: UseMulticall3ExecutionProps) {
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { showAlert } = useAlert()

  /**
   * Verify Multicall3 actually exists at the canonical address on the
   * currently-connected chain. If we're on a chain where it isn't deployed
   * (custom L2, pristine anvil) the batched send would just revert; we'd
   * rather detect that here and fall back to the sequential path.
   */
  const verifyMulticall3Deployed = useCallback(async (): Promise<boolean> => {
    if (!publicClient) return false
    try {
      const code = await publicClient.getCode({ address: MULTICALL3_ADDRESS })
      return !!code && code !== '0x'
    } catch {
      return false
    }
  }, [publicClient])

  /**
   * Splits the pending transactions into one-or-more chunks, each estimated
   * to fit inside `BLOCK_GAS_FRACTION_PCT` of the chain's current block gas
   * limit. Order is preserved across chunks so the cart's `dependsOn`
   * chain stays valid (claims always come before their distribute, etc.).
   *
   * Strategy:
   *   1. Estimate gas for the full remaining tail. If it fits, that's the
   *      last chunk and we're done.
   *   2. Otherwise binary-search for the longest prefix that fits, emit
   *      it as a chunk, recurse on the remainder.
   *
   * If even a single entry doesn't fit (extreme edge case), we still emit
   * that single entry as its own chunk — `simulateBatch` will surface the
   * real revert reason at send time rather than us guessing here.
   */
  const chunkByGasLimit = useCallback(async (
    pendingTransactions: CartTransaction[],
  ): Promise<CartTransaction[][]> => {
    if (!publicClient || !walletClient?.account?.address) {
      // Best-effort fallback: one big chunk. The downstream simulation will
      // fail with a clearer error than us trying to estimate without clients.
      return [pendingTransactions]
    }
    const account = walletClient.account.address

    const block = await publicClient.getBlock()
    const blockGasLimit = block.gasLimit
    const maxGasPerTx = (blockGasLimit * BLOCK_GAS_FRACTION_PCT) / 100n

    const estimateChunkGas = async (txs: CartTransaction[]): Promise<bigint | null> => {
      try {
        return await publicClient.estimateContractGas({
          account,
          address: MULTICALL3_ADDRESS,
          abi: Multicall3Abi,
          functionName: 'aggregate3',
          args: [txs.map((tx) => ({
            target: tx.transaction.to,
            allowFailure: false,
            callData: tx.transaction.data,
          }))],
          value: 0n,
        })
      } catch {
        // Estimation reverted. Could be a doomed call or an RPC quirk. Treat
        // as "didn't fit" so the binary search shrinks the chunk; if it
        // shrinks all the way to 1 and STILL fails, the loop will emit that
        // single entry and let simulateBatch surface the real reason.
        return null
      }
    }

    const chunks: CartTransaction[][] = []
    let remaining = pendingTransactions

    while (remaining.length > 0) {
      // Fast path: does the whole tail fit?
      const wholeEstimate = await estimateChunkGas(remaining)
      if (wholeEstimate !== null && wholeEstimate <= maxGasPerTx) {
        chunks.push(remaining)
        break
      }

      // Binary search for the longest prefix that fits. We know length=1
      // is always at least attempted (worst case), and length=`remaining.length`
      // didn't fit. Search the (1, remaining.length-1) interval.
      let lo = 1
      let hi = remaining.length - 1
      let bestFitLen = 1 // sentinel: emit the head entry alone if nothing else fits
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const gas = await estimateChunkGas(remaining.slice(0, mid))
        if (gas !== null && gas <= maxGasPerTx) {
          bestFitLen = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }

      chunks.push(remaining.slice(0, bestFitLen))
      remaining = remaining.slice(bestFitLen)
    }

    return chunks
  }, [publicClient, walletClient])

  /**
   * Pre-flight simulation. Runs the whole multicall against the latest
   * pending state. If anything inside would revert, we abort here and
   * surface the reason — the user never sees a doomed wallet prompt.
   *
   * Returns the decoded `returnData` array on success so callers can do
   * outcome verification on top.
   */
  const simulateBatch = useCallback(async (
    pendingTransactions: CartTransaction[],
  ): Promise<
    | { ok: true; returnData: ReadonlyArray<{ success: boolean; returnData: Hex }> }
    | { ok: false; reason: string }
  > => {
    if (!publicClient || !walletClient) return { ok: false, reason: 'No client available' }
    const account = walletClient.account?.address
    if (!account) return { ok: false, reason: MULTICALL3_ERROR.NO_ACCOUNT }
    try {
      const { result } = await publicClient.simulateContract({
        account,
        address: MULTICALL3_ADDRESS,
        abi: Multicall3Abi,
        functionName: 'aggregate3',
        args: [
          pendingTransactions.map((tx) => ({
            target: tx.transaction.to,
            allowFailure: false,
            callData: tx.transaction.data,
          })),
        ],
        value: 0n,
      })
      return { ok: true, returnData: result as ReadonlyArray<{ success: boolean; returnData: Hex }> }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown simulation error'
      return { ok: false, reason }
    }
  }, [publicClient, walletClient])

  /**
   * Stretch outcome verification. With `allowFailure: false`, every inner
   * call MUST have `success === true` by definition — simulation would have
   * reverted otherwise. We assert that anyway, since a `success: false` here
   * would indicate either an unsafe encoding (someone flipped allowFailure)
   * or an unexpected Multicall3 deployment quirk on a custom chain. Cheap
   * defence-in-depth.
   *
   * Future expansion: parse known event topics out of the simulation trace
   * to assert "the user's balance went up by the expected amount", "the
   * split is empty after distribute", etc. For now we just validate the
   * structural invariant.
   */
  function verifyOutcome(
    returnData: ReadonlyArray<{ success: boolean; returnData: Hex }>,
    expectedCount: number,
  ): { ok: true } | { ok: false; reason: string } {
    if (returnData.length !== expectedCount) {
      return { ok: false, reason: `Simulation returned ${returnData.length} results, expected ${expectedCount}` }
    }
    const failedIdx = returnData.findIndex((r) => !r.success)
    if (failedIdx !== -1) {
      return { ok: false, reason: `Simulation reported a soft failure at entry #${failedIdx + 1}` }
    }
    return { ok: true }
  }

  const executeTransactions = useCallback(async (
    pendingTransactions: CartTransaction[],
    allTransactions: CartTransaction[],
  ): Promise<void> => {
    if (!walletClient || !publicClient) {
      showAlert('error', 'Wallet client not ready')
      return
    }

    // `walletClient.account` can transiently be undefined between connect
    // and the wagmi store flushing. Hard-guard before we use the address.
    if (!walletClient.account?.address) {
      throw new Error(MULTICALL3_ERROR.NO_ACCOUNT)
    }

    // The wagmi `publicClient` and `walletClient` track the connected chain
    // independently. During a chain-switch the two can briefly disagree —
    // running a simulation on chain A and then `sendTransaction` landing on
    // chain B would use different Multicall3 codes / nonce space / state.
    // Fail closed instead.
    if (publicClient.chain?.id !== walletClient.chain?.id) {
      throw new Error(MULTICALL3_ERROR.CHAIN_MISMATCH)
    }

    const hasExecutingTx = allTransactions.some((tx) => tx.status === 'executing' && tx.txHash)
    if (hasExecutingTx) {
      showAlert('info', 'Please wait for the current transaction to complete')
      return
    }

    // Belt-and-braces guard. The dispatcher already checks eligibility — re-check here
    // so this hook can never silently send a non-claim or value-bearing tx through Multicall3.
    if (!isMulticall3Eligible(pendingTransactions)) {
      throw new Error(MULTICALL3_ERROR.DISPATCHER_BUG)
    }

    // Step 1: confirm Multicall3 lives at the canonical address on this chain.
    const deployed = await verifyMulticall3Deployed()
    if (!deployed) {
      throw new Error(MULTICALL3_ERROR.NOT_DEPLOYED)
    }

    // Step 2: split into gas-safe chunks. Most carts produce exactly one chunk;
    // large operator carts split into 2-3. Order is preserved across chunks so
    // dependsOn semantics still hold (e.g., claim before its distribute).
    const chunks = await chunkByGasLimit(pendingTransactions)
    if (chunks.length > 1) {
      showAlert(
        'info',
        `This batch will execute in ${chunks.length} signatures to stay under the block gas limit.`,
      )
    }

    setCurrentExecutingId(null)

    // Step 3: process each chunk: simulate → mark executing → send → wait → mark complete.
    // On a failure mid-flow (rejection or revert), earlier chunks stay COMPLETED on-chain,
    // the current chunk is marked FAILED, and untouched downstream chunks stay PENDING so
    // the user can retry by clicking Execute again.
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const chunkLabel = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''

      // 3a. Simulate this chunk against the latest state (post-previous-chunk if any).
      const sim = await simulateBatch(chunk)
      if (!sim.ok) {
        showAlert('error', `Batch simulation failed${chunkLabel}: ${sim.reason}`)
        return
      }

      // 3b. Structural outcome verification — every inner success flag true.
      const outcome = verifyOutcome(sim.returnData, chunk.length)
      if (!outcome.ok) {
        showAlert('error', `Batch outcome check failed${chunkLabel}: ${outcome.reason}`)
        return
      }

      // 3c. Mark chunk entries `executing` (untouched downstream chunks stay pending).
      setTransactions((prev) => prev.map((t) =>
        chunk.some((p) => p.id === t.id)
          ? { ...t, status: 'executing' as TransactionStatus }
          : t,
      ))

      // 3d. Send. Default gas estimation by viem; the chunker already kept us under
      //     a safe fraction of the block gas limit so this rarely surprises.
      try {
        const data = buildAggregateCalldata(chunk)
        const hash = await walletClient.sendTransaction({
          to: MULTICALL3_ADDRESS,
          data,
          value: 0n,
        })
        setTransactions((prev) => prev.map((t) =>
          chunk.some((p) => p.id === t.id) ? { ...t, txHash: hash } : t,
        ))

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error(`Multicall3 transaction reverted on-chain${chunkLabel}`)
        }
        setTransactions((prev) => prev.map((t) =>
          chunk.some((p) => p.id === t.id)
            ? { ...t, status: 'completed' as TransactionStatus, txHash: hash }
            : t,
        ))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        if (isUserRejection(errorMessage)) {
          // Reset just THIS chunk to pending (downstream chunks were never touched).
          setTransactions((prev) => prev.map((t) =>
            chunk.some((p) => p.id === t.id)
              ? { ...t, status: 'pending' as TransactionStatus }
              : t,
          ))
          throw new Error(`User rejected batch transaction${chunkLabel}`)
        }
        // Hard failure: mark THIS chunk failed and bail. Earlier chunks stay completed
        // (they're on-chain); later chunks stay pending so the user can retry them.
        // Normalise known contract errors so the cart panel surfaces a useful reason.
        const friendlyError = parseContractError(errorMessage)
        setTransactions((prev) => prev.map((t) =>
          chunk.some((p) => p.id === t.id)
            ? { ...t, status: 'failed' as TransactionStatus, error: friendlyError }
            : t,
        ))
        throw error
      }
    }

    // Note: success toast lives in the dispatcher
    // (`useTransactionExecution.executeAll`) so multi-segment carts don't
    // emit one toast per segment.
  }, [walletClient, publicClient, setTransactions, setCurrentExecutingId, showAlert, verifyMulticall3Deployed, simulateBatch, chunkByGasLimit])

  return { executeTransactions, isMulticall3Eligible }
}
