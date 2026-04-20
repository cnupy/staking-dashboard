/**
 * Aztec Registry Contract ABI
 *
 * The Registry tracks the canonical rollup instance over time. When a new
 * rollup is deployed (e.g. on upgrade), `addRollup()` is called which emits
 * `CanonicalRollupUpdated`. The indexer uses this event as a factory source
 * so every rollup (past, present, and future) is indexed automatically.
 */

export const CanonicalRollupUpdatedEventAbi = {
  type: 'event',
  name: 'CanonicalRollupUpdated',
  inputs: [
    { name: 'instance', type: 'address', indexed: true },
    { name: 'version', type: 'uint256', indexed: true },
  ],
  anonymous: false,
} as const;

export const REGISTRY_FUNCTIONS = [
  {
    type: 'function',
    name: 'getCanonicalRollup',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'numberOfVersions',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export const REGISTRY_ABI = [
  CanonicalRollupUpdatedEventAbi,
  ...REGISTRY_FUNCTIONS,
] as const;
