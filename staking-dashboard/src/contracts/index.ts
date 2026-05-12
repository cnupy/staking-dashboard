import { z } from "zod";
import { isAddress, type Address } from "viem";

import { ATPFactoryAbi } from "./abis/ATPFactory";
import { StakingRegistryAbi } from "./abis/StakingRegistry";
import { AtpRegistryAbi } from "./abis/ATPRegistry";
import { RollupAbi } from "./abis/Rollup";
import { GenesisSequencerSale } from "./abis/GenesisSequencerSale";
import { ATPWithdrawableAndClaimableStakerAbi } from "./abis/ATPWithdrawableAndClaimableStaker";
import { GovernanceAbi } from "./abis/Governance";
import { GSEAbi } from "./abis/GSE";

// Define a reusable schema for Ethereum addresses
const addressSchema = z
  .string()
  .refine((val) => isAddress(val), {
    message: "Invalid Ethereum address",
  })
  .transform((val) => val as Address);

const contractEnvSchema = z.object({
  VITE_ATP_FACTORY_ADDRESS: addressSchema,
  VITE_ATP_FACTORY_AUCTION_ADDRESS: addressSchema,
  VITE_ATP_REGISTRY_ADDRESS: addressSchema,
  VITE_ATP_REGISTRY_AUCTION_ADDRESS: addressSchema,
  VITE_STAKING_REGISTRY_ADDRESS: addressSchema,
  VITE_GENESIS_SEQUENCER_SALE_ADDRESS: addressSchema.optional(),
  VITE_ATP_WITHDRAWABLE_AND_CLAIMABLE_STAKER_ADDRESS: addressSchema,
  VITE_GOVERNANCE_ADDRESS: addressSchema,
  VITE_GSE_ADDRESS: addressSchema,
});

// Validate eagerly at startup
const env = contractEnvSchema.parse(import.meta.env);

/**
 * A rollup version record as returned by GET /api/rollups.
 * Ordered oldest first in the API response.
 */
export interface RollupVersion {
  version: string;
  address: Address;
  blockNumber: number;
  timestamp: number;
}

// The canonical rollup is resolved at boot from the indexer's /api/rollups
// endpoint (backed by the Registry:CanonicalRollupUpdated event). We also
// cache the full version history for future cross-rollup flows (e.g.
// claiming rewards from an old rollup). Callers still read
// `contracts.rollup.address` synchronously; `initRollupVersions()` is
// awaited in main.tsx before React renders so the getter always returns a
// real address.
let _canonicalRollupAddress: Address | null = null;
let _rollupVersions: RollupVersion[] = [];

// Runtime schema for the `/api/rollups` response. These addresses feed into
// `writeContract` targets when users claim rewards, so validate them at the
// trust boundary — a malformed / poisoned indexer response should fail fast
// rather than silently route a tx to an unchecked string.
const rollupVersionSchema = z.object({
  version: z.string(),
  address: addressSchema,
  blockNumber: z.number(),
  timestamp: z.number(),
});

const rollupsApiResponseSchema = z.object({
  canonical: addressSchema.nullable(),
  versions: z.array(rollupVersionSchema),
});

export async function initRollupVersions(): Promise<Address> {
  const apiHost = import.meta.env.VITE_API_HOST;
  if (!apiHost) {
    throw new Error("VITE_API_HOST must be set to resolve the canonical rollup");
  }

  const res = await fetch(`${apiHost}/api/rollups`);
  if (!res.ok) {
    throw new Error(`/api/rollups returned ${res.status}`);
  }

  const parsed = rollupsApiResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`/api/rollups returned an invalid response: ${parsed.error.message}`);
  }
  const body = parsed.data;

  if (!body.canonical || body.versions.length === 0) {
    throw new Error(
      "Indexer has not yet recorded a canonical rollup; the Registry:CanonicalRollupUpdated event has not been processed. Wait for the indexer to catch up past the Registry deployment block."
    );
  }

  _rollupVersions = body.versions;
  _canonicalRollupAddress = body.canonical;
  return _canonicalRollupAddress;
}

/**
 * All rollup versions the Registry has ever made canonical, oldest first.
 * Empty until `initRollupVersions()` resolves.
 */
export function getRollupVersions(): readonly RollupVersion[] {
  return _rollupVersions;
}

const contracts = {
  atpFactory: {
    address: env.VITE_ATP_FACTORY_ADDRESS,
    abi: ATPFactoryAbi,
  },
  atpFactoryAuction: {
    address: env.VITE_ATP_FACTORY_AUCTION_ADDRESS,
    abi: ATPFactoryAbi,
  },
  atpRegistry: {
    address: env.VITE_ATP_REGISTRY_ADDRESS,
    abi: AtpRegistryAbi,
  },
  atpRegistryAuction: {
    address: env.VITE_ATP_REGISTRY_AUCTION_ADDRESS,
    abi: AtpRegistryAbi,
  },
  stakingRegistry: {
    address: env.VITE_STAKING_REGISTRY_ADDRESS,
    abi: StakingRegistryAbi,
  },
  rollup: {
    get address(): Address {
      if (!_canonicalRollupAddress) {
        throw new Error(
          "Canonical rollup address not initialized: initRollupVersions() must be awaited before app render"
        );
      }
      return _canonicalRollupAddress;
    },
    abi: RollupAbi,
  },
  genesisSequencerSale: {
    address: env.VITE_GENESIS_SEQUENCER_SALE_ADDRESS,
    abi: GenesisSequencerSale,
  },
  atpWithdrawableAndClaimableStaker: {
    address: env.VITE_ATP_WITHDRAWABLE_AND_CLAIMABLE_STAKER_ADDRESS,
    abi: ATPWithdrawableAndClaimableStakerAbi,
  },
  governance: {
    address: env.VITE_GOVERNANCE_ADDRESS,
    abi: GovernanceAbi,
  },
  gse: {
    address: env.VITE_GSE_ADDRESS,
    abi: GSEAbi,
  },
} as const;

export { contracts };
