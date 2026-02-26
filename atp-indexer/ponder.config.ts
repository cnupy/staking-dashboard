import { createConfig, DatabaseConfig, factory } from "ponder";
import { parseAbiItem } from "viem";
import { config } from "./src/config";
import {
  ATP_ABI,
  STAKING_REGISTRY_ABI,
  ROLLUP_ABI,
  STAKER_ABI,
} from "./src/abis";

// ATPCreated event signature for factory pattern
const ATPCreatedEvent = parseAbiItem(
  "event ATPCreated(address indexed beneficiary, address indexed atp, uint256 allocation)"
);

// Per-factory start blocks for efficient indexing
const FACTORY_START_BLOCKS = {
  genesis: config.START_BLOCK || 0,
  auction: config.START_BLOCK || 0,
  matp: config.MATP_FACTORY_START_BLOCK || config.START_BLOCK || 0,
  latp: config.LATP_FACTORY_START_BLOCK || config.START_BLOCK || 0,
};


let databaseConfig: DatabaseConfig | undefined;

if (config.POSTGRES_CONNECTION_STRING) {
  const pgSSLMode = new URL(config.POSTGRES_CONNECTION_STRING as string).searchParams.get('sslmode');
  let pgSSLConfig: { rejectUnauthorized: boolean } | undefined;
  if (pgSSLMode === 'require') {
    pgSSLConfig = { rejectUnauthorized: true };
  } else if (pgSSLMode === 'no-verify') {
    pgSSLConfig = { rejectUnauthorized: false };
  }

  databaseConfig = {
    kind: 'postgres',
    connectionString: config.POSTGRES_CONNECTION_STRING,
    poolConfig: {
      ssl: pgSSLConfig,
    },
  };
} else {
  databaseConfig = {
    kind: 'pglite',
  };
}

export default createConfig({
  database: databaseConfig,
  chains: {
    [config.networkName]: {
      id: config.CHAIN_ID,
      rpc: config.RPC_URL,
    },
  },
  contracts: {
    /**
     * ATP Factory - Genesis Sale contract
     * Emits ATPCreated events when new ATP positions are created
     */
    ATPFactory: {
      chain: config.networkName,
      abi: ATP_ABI,
      address: config.ATP_FACTORY_ADDRESS as `0x${string}`,
      startBlock: FACTORY_START_BLOCKS.genesis,
    },

    /**
     * ATP Factory - Auction contract
     * Alternative factory for auction-based ATP creation
     */
    ATPFactoryAuction: {
      chain: config.networkName,
      abi: ATP_ABI,
      address: config.ATP_FACTORY_AUCTION_ADDRESS as `0x${string}`,
      startBlock: FACTORY_START_BLOCKS.auction,
    },

    /**
     * ATP Factory - MATP contract
     * Issues milestone-based ATPs (MATPs)
     */
    ATPFactoryMATP: {
      chain: config.networkName,
      abi: ATP_ABI,
      address: config.ATP_FACTORY_MATP_ADDRESS as `0x${string}`,
      startBlock: FACTORY_START_BLOCKS.matp,
    },

    /**
     * ATP Factory - LATP contract
     * Issues linear vesting ATPs (LATPs) and MATPs
     */
    ATPFactoryLATP: {
      chain: config.networkName,
      abi: ATP_ABI,
      address: config.ATP_FACTORY_LATP_ADDRESS as `0x${string}`,
      startBlock: FACTORY_START_BLOCKS.latp,
    },

    /**
     * Staking Registry
     * Central contract managing providers and staking operations
     */
    StakingRegistry: {
      chain: config.networkName,
      abi: STAKING_REGISTRY_ABI,
      address: config.STAKING_REGISTRY_ADDRESS as `0x${string}`,
      startBlock: config.START_BLOCK,
    },

    /**
     * Rollup Contract
     * Handles validator deposits and tracks validator queue
     */
    Rollup: {
      chain: config.networkName,
      abi: ROLLUP_ABI,
      address: config.ROLLUP_ADDRESS as `0x${string}`,
      startBlock: config.START_BLOCK,
    },

    /**
     * Dynamic ATP Contracts
     * Created by factory events, tracks operator updates
     * Uses factory pattern to only index ATPs created by all 4 factories
     */
    ATP: {
      chain: config.networkName,
      abi: ATP_ABI,
      address: factory({
        address: [
          config.ATP_FACTORY_ADDRESS as `0x${string}`,
          config.ATP_FACTORY_AUCTION_ADDRESS as `0x${string}`,
          config.ATP_FACTORY_MATP_ADDRESS as `0x${string}`,
          config.ATP_FACTORY_LATP_ADDRESS as `0x${string}`,
        ],
        event: ATPCreatedEvent,
        parameter: "atp",
      }),
      // Use earliest factory start block to capture all ATP contracts
      startBlock: Math.min(...Object.values(FACTORY_START_BLOCKS)),
    },

    /**
     * Dynamic Staker Contracts
     * Linked to ATP positions via getStaker() call
     * Note: Cannot use factory pattern since Staker addresses are derived, not emitted.
     * Events are filtered in handlers by checking against known ATP positions.
     */
    Staker: {
      chain: config.networkName,
      abi: STAKER_ABI,
      startBlock: config.START_BLOCK,
    },
  },
});
