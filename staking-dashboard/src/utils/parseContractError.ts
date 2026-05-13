/**
 * Normalise on-chain revert reasons into user-readable strings. Maps known
 * Aztec staking/withdrawal error selectors + signatures to plain English so
 * the user sees "Exit delay has not passed yet" instead of a raw
 * `0xef566ee0`. Used by the cart's failure-reason rendering and by anyone
 * else surfacing tx errors.
 *
 * Only normalises errors we've seen in the wild — unknown errors fall
 * through to the original message (truncated if very long).
 */
export function parseContractError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Transaction failed"

  const errorMappings: Record<string, string> = {
    Staking__NotExiting: "Sequencer is not in exiting state. Initiate unstake first.",
    Staking__ExitDelayNotPassed: "Exit delay has not passed yet. Please wait for the withdrawal period to complete.",
    Staking__WithdrawalDelayNotPassed: "Withdrawal delay has not passed yet. Please wait for the withdrawal period to complete.",
    Staking__NotTheWithdrawer: "You are not the withdrawer for this stake. Only the original staker can initiate withdrawal.",
    NotExiting: "Sequencer is not in exiting state.",
    ExitDelayNotPassed: "Exit delay has not passed yet.",
    NotTheWithdrawer: "Only the withdrawer can initiate withdrawal.",
    "0xef566ee0": "Exit delay has not passed yet. Please wait for the withdrawal period to complete.",
  }

  for (const [pattern, friendly] of Object.entries(errorMappings)) {
    if (message.includes(pattern)) return friendly
  }

  // `reverted with reason string "X"`
  const revertMatch = message.match(/reverted with.*?["']([^"']+)["']/i)
  if (revertMatch) return revertMatch[1]

  // Custom error data buried in an `error={ "data": "0x..." }` blob
  const customErrorMatch = message.match(/error=\{[^}]*"data":"(0x[a-f0-9]+)"/i)
  if (customErrorMatch) {
    const errorData = customErrorMatch[1]
    for (const [selector, friendly] of Object.entries(errorMappings)) {
      if (errorData.startsWith(selector)) return friendly
    }
  }

  // Nonce error masking a contract revert with a known selector
  if (message.includes("nonce") && message.includes("0x")) {
    const selectorMatch = message.match(/0x[a-f0-9]{8}/i)
    if (selectorMatch) {
      const selector = selectorMatch[0].toLowerCase()
      const friendly = errorMappings[selector]
      if (friendly) return friendly
    }
    return "Transaction failed. The contract rejected the call — please check that all conditions are met."
  }

  if (message.length > 200) return message.substring(0, 200) + "..."
  return message || "Transaction failed"
}
