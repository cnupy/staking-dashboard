/**
 * Seed multi-rollup reward state on a forked-mainnet anvil.
 *
 * Auto-discovers rollups by reading `Registry.CanonicalRollupUpdated` events,
 * then writes `sequencerRewards[TARGET_ADDRESS]` on each rollup via
 * `anvil_setStorageAt`. The fork already has real fee-asset balances and
 * `isRewardsClaimable=true` from mainnet state, so nothing else needs touching.
 *
 * Run from repo root:
 *   npx tsx staking-dashboard/scripts/multi-rollup-test/seed-fork.ts
 *
 * Env overrides:
 *   TARGET_ADDRESS  - address to seed rewards for (default: anvil account 0)
 *   RPC_URL         - anvil RPC URL (default: http://127.0.0.1:8545)
 *   REWARD_AMOUNTS  - comma-separated reward amounts in whole tokens, oldest
 *                     rollup first (default: "5,10" — 5 on v1, 10 on v2)
 */

import {
  createPublicClient,
  createTestClient,
  http,
  keccak256,
  encodeAbiParameters,
  numberToHex,
  stringToHex,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ADDRS_FILE = resolve(REPO_ROOT, "atp-indexer/contract_addresses.json");

const TARGET_ADDRESS = (
  process.env.TARGET_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
) as Address;
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const REWARD_AMOUNTS = (process.env.REWARD_AMOUNTS ?? "5,10")
  .split(",")
  .map((s) => BigInt(s.trim()));

const addrs = JSON.parse(readFileSync(ADDRS_FILE, "utf-8"));
const REGISTRY_ADDRESS = addrs.registryAddress as Address;
const REGISTRY_DEPLOY_BLOCK = BigInt(addrs.registryDeploymentBlock);

// ERC-7201-style namespaced storage. Base = keccak256 of the raw UTF-8 string
// (NOT abi.encode("aztec.reward.storage"), which produces a different hash).
//   slot 0: mapping(address => uint256) sequencerRewards
const REWARD_STORAGE_BASE = keccak256(stringToHex("aztec.reward.storage"));
const SEQUENCER_REWARDS_SLOT = BigInt(REWARD_STORAGE_BASE);

const CANONICAL_UPDATED_EVENT = {
  type: "event",
  name: "CanonicalRollupUpdated",
  inputs: [
    { name: "instance", type: "address", indexed: true },
    { name: "version", type: "uint256", indexed: true },
  ],
} as const;

const rollupAbi = parseAbi([
  "function getSequencerRewards(address) view returns (uint256)",
  "function isRewardsClaimable() view returns (bool)",
  "function getVersion() view returns (uint256)",
  "function getFeeAsset() view returns (address)",
]);

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport: http(RPC_URL) });

function mappingSlot(key: Address, baseSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, baseSlot]),
  );
}

async function discoverRollups(): Promise<{ address: Address; version: bigint; blockNumber: bigint }[]> {
  const logs = await publicClient.getLogs({
    address: REGISTRY_ADDRESS,
    event: CANONICAL_UPDATED_EVENT,
    fromBlock: REGISTRY_DEPLOY_BLOCK,
    toBlock: "latest",
  });

  // Dedupe by rollup address. Keep oldest event per rollup (first canonical).
  const seen = new Map<Address, { address: Address; version: bigint; blockNumber: bigint }>();
  for (const log of logs as Log[]) {
    const args = (log as unknown as { args: { instance: Address; version: bigint } }).args;
    const addr = args.instance.toLowerCase() as Address;
    if (!seen.has(addr)) {
      seen.set(addr, {
        address: args.instance,
        version: args.version,
        blockNumber: log.blockNumber!,
      });
    }
  }
  return [...seen.values()].sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

async function main() {
  console.log(`\nSeeding multi-rollup rewards on fork`);
  console.log(`  RPC:    ${RPC_URL}`);
  console.log(`  target: ${TARGET_ADDRESS}\n`);

  const chainId = await publicClient.getChainId();
  if (chainId !== 1) {
    throw new Error(`expected chainId 1 (mainnet fork), got ${chainId}`);
  }

  const rollups = await discoverRollups();
  if (rollups.length === 0) {
    throw new Error(`no CanonicalRollupUpdated events found on Registry ${REGISTRY_ADDRESS}`);
  }
  console.log(`Discovered ${rollups.length} rollup(s) from Registry events:`);
  for (const r of rollups) {
    console.log(`  - ${r.address}  (version=${r.version}, block=${r.blockNumber})`);
  }
  console.log();

  if (REWARD_AMOUNTS.length < rollups.length) {
    console.warn(
      `Note: ${rollups.length} rollups discovered but only ${REWARD_AMOUNTS.length} reward amount(s) given; ` +
        `remaining rollups will be seeded with the last value (${REWARD_AMOUNTS[REWARD_AMOUNTS.length - 1]}).`,
    );
  }

  const slot = mappingSlot(TARGET_ADDRESS, SEQUENCER_REWARDS_SLOT);
  for (let i = 0; i < rollups.length; i++) {
    const rollup = rollups[i];
    const amount = REWARD_AMOUNTS[Math.min(i, REWARD_AMOUNTS.length - 1)] * 10n ** 18n;

    await testClient.setStorageAt({
      address: rollup.address,
      index: slot,
      value: numberToHex(amount, { size: 32 }),
    });

    // Verify via the contract getter (covers both slot calc and the fork actually accepting the write)
    const got = await publicClient.readContract({
      address: rollup.address,
      abi: rollupAbi,
      functionName: "getSequencerRewards",
      args: [TARGET_ADDRESS],
    });
    if (got !== amount) {
      throw new Error(
        `verification failed for ${rollup.address}: wrote ${amount} but getSequencerRewards returned ${got}`,
      );
    }

    // Sanity: claimSequencerRewards transfers fee asset from the rollup, so the
    // rollup needs to hold at least `amount` of it. On a fresh mainnet fork this
    // is true (rollups already hold the AZTEC token). Warn if it's not.
    const feeAsset = await publicClient.readContract({
      address: rollup.address,
      abi: rollupAbi,
      functionName: "getFeeAsset",
    });
    const feeBal = await publicClient.readContract({
      address: feeAsset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [rollup.address],
    });
    const claimable = await publicClient.readContract({
      address: rollup.address,
      abi: rollupAbi,
      functionName: "isRewardsClaimable",
    });

    console.log(
      `  ✓ ${rollup.address}  rewards=${amount} claimable=${claimable} ` +
        `feeBal=${feeBal} ${feeBal < amount ? "(LOW — claim will revert)" : ""}`,
    );
  }

  const lsKey = `rewards_coinbase_addresses_${TARGET_ADDRESS.toLowerCase()}`;
  const lsValue = JSON.stringify([TARGET_ADDRESS.toLowerCase()]);
  console.log(`\nDone. In the dashboard's DevTools console, paste:`);
  console.log(`  localStorage.setItem('${lsKey}', '${lsValue}'); location.reload();`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message ?? err}\n`);
  process.exit(1);
});
