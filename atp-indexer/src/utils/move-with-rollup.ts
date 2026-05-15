import { decodeFunctionData, toFunctionSelector, type Abi, type AbiFunction } from "viem"

/**
 * Minimal ABI fragments for the user-facing entry points that take a
 * `_moveWithLatestRollup` / `_moveWithRollup` boolean. We only need the
 * function signatures to decode calldata — never to encode or send — so we
 * keep these fragments local to the decoder rather than bloating the
 * indexer's main ABI files (which are scoped to events + view reads).
 *
 * If a new entry point is added to the protocol, append its signature here.
 */
const ROLLUP_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "_attester", type: "address" },
      { name: "_withdrawer", type: "address" },
      {
        name: "_publicKeyInG1",
        type: "tuple",
        components: [
          { name: "x", type: "uint256" },
          { name: "y", type: "uint256" },
        ],
      },
      {
        name: "_publicKeyInG2",
        type: "tuple",
        components: [
          { name: "x0", type: "uint256" },
          { name: "x1", type: "uint256" },
          { name: "y0", type: "uint256" },
          { name: "y1", type: "uint256" },
        ],
      },
      {
        name: "_proofOfPossession",
        type: "tuple",
        components: [
          { name: "x", type: "uint256" },
          { name: "y", type: "uint256" },
        ],
      },
      { name: "_moveWithRollup", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const satisfies Abi

const STAKING_REGISTRY_STAKE_ABI = [
  {
    type: "function",
    name: "stake",
    inputs: [
      { name: "_providerIdentifier", type: "uint256" },
      { name: "_rollupVersion", type: "uint256" },
      { name: "_withdrawalAddress", type: "address" },
      { name: "_expectedProviderTakeRate", type: "uint16" },
      { name: "_userRewardsRecipient", type: "address" },
      { name: "_moveWithLatestRollup", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const satisfies Abi

const STAKER_STAKE_ABI = [
  {
    type: "function",
    name: "stake",
    inputs: [
      { name: "_providerIdentifier", type: "uint256" },
      { name: "_rollupVersion", type: "uint256" },
      { name: "_attester", type: "address" },
      { name: "_expectedProviderTakeRate", type: "uint16" },
      { name: "_userRewardsRecipient", type: "address" },
      { name: "_moveWithLatestRollup", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const satisfies Abi

/**
 * Selector → (abi, target function) lookup table, computed once at module
 * load. Dispatching on the 4-byte selector is the deterministic way to
 * decode: it eliminates the "wrong-ABI happens to decode because all args
 * are 32-byte words" hazard that an exception-driven trial-and-error
 * approach would have.
 *
 * Note that `StakingRegistry.stake(uint256,uint256,address,uint16,address,bool)`
 * and `Staker.stake(uint256,uint256,address,uint16,address,bool)` share the
 * same Solidity signature once the `_rollupVersion`/`_attester` parameter
 * names are erased — so they share the same selector and either ABI
 * decodes the result identically. We pick StakingRegistry as canonical and
 * note this in the lookup.
 */
function buildSelectorTable(): Map<string, { abi: Abi; fn: AbiFunction }> {
  const out = new Map<string, { abi: Abi; fn: AbiFunction }>()
  const candidates: Abi[] = [ROLLUP_DEPOSIT_ABI, STAKING_REGISTRY_STAKE_ABI, STAKER_STAKE_ABI]

  for (const abi of candidates) {
    for (const item of abi) {
      if (item.type !== "function") continue
      const fn = item as AbiFunction
      const selector = toFunctionSelector(fn)
      // First wins. The StakingRegistry and Staker `stake(...)` have the
      // same selector by Solidity's signature rules; either decodes the
      // calldata to the same args, so it doesn't matter which one we keep.
      if (!out.has(selector)) out.set(selector, { abi, fn })
    }
  }
  return out
}

const SELECTOR_TABLE = buildSelectorTable()

/**
 * Try to decode the `moveWithRollup` boolean from a transaction's calldata.
 *
 * The on-chain `Deposit` event doesn't include the flag — it's an arg to
 * the originating function call — so we recover it from the originating
 * tx's input. We dispatch on the 4-byte function selector to pick the
 * correct ABI deterministically (rather than try-each-ABI-and-hope).
 *
 * Returns:
 *   - `true` / `false` when the selector matches a known entry point and
 *     the matched function's arg with name `_moveWithLatestRollup` or
 *     `_moveWithRollup` decodes to a boolean.
 *   - `null` when the selector matches no known entry point (e.g. the
 *     deposit was issued via Safe.execTransaction, MultiSend, a router,
 *     or any contract we haven't catalogued here), or the decode fails
 *     for any other reason. Indexer rows persisted with `null` are
 *     treated by the canonical-rollup migration handler as "presume
 *     migrating" — the dashboard's on-chain probe is the safety net
 *     for the rare case the user actually deposited with `false`.
 */
export function decodeMoveWithRollup(calldata: `0x${string}`): boolean | null {
  // Every Solidity call carries at least a 4-byte selector (0x + 8 hex chars).
  if (!calldata || calldata.length < 10) return null

  const selector = calldata.slice(0, 10) as `0x${string}`
  const match = SELECTOR_TABLE.get(selector)
  if (!match) return null

  try {
    const decoded = decodeFunctionData({ abi: match.abi, data: calldata })
    const idx = match.fn.inputs.findIndex(
      (inp) => inp.name === "_moveWithLatestRollup" || inp.name === "_moveWithRollup",
    )
    if (idx < 0) return null

    const value = (decoded.args as readonly unknown[])[idx]
    return typeof value === "boolean" ? value : null
  } catch {
    // Malformed calldata for the matched selector — exceedingly rare in
    // practice (would require an on-chain tx that crashed before
    // executing). Treat as unknown.
    return null
  }
}
