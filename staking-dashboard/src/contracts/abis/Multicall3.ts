/**
 * Subset of the Multicall3 ABI we use for batched cart execution.
 *
 * Multicall3 is deployed at the same canonical address on every major EVM
 * chain (`0xcA11bde05977b3631167028862bE2a173976CA11`). We only need
 * `aggregate3` — it takes an array of `(target, allowFailure, callData)` and
 * executes each call in order. With `allowFailure: false`, a single revert
 * inside any call reverts the whole multicall, which mirrors the cart's
 * existing "abort on first failure" semantic.
 *
 * Reference: https://github.com/mds1/multicall
 */
export const Multicall3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/**
 * Multicall3's canonical deterministic deployment address. Same on every
 * mainnet + most testnets the dashboard targets. Local anvil forks of mainnet
 * pick this up for free; pristine anvil chains need it set via the
 * `multi-rollup-test` deploy script.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
