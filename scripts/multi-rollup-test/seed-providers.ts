/**
 * Register a handful of test providers on the real StakingRegistry so the
 * indexer's /api/providers endpoint returns non-empty data.
 *
 * The real StakingRegistry assigns provider IDs sequentially via
 * `nextProviderIdentifier` (starting at 1), so the IDs we end up with are
 * 1..N rather than the production IDs. That's fine for testing; the goal is
 * to populate the table, not to match production.
 *
 * Run from repo root:
 *   npx tsx staking-dashboard/scripts/multi-rollup-test/seed-providers.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const INDEXER_ROOT = resolve(REPO_ROOT, "atp-indexer");

const deployOutput = JSON.parse(readFileSync(resolve(SCRIPT_DIR, "deploy-output.json"), "utf-8"));
const rpcUrl = deployOutput.rpcUrl || "http://127.0.0.1:8545";
const stakingRegistry = deployOutput.stakingRegistryAddress as Address;

// Use provider names from the indexer metadata so the dashboard renders
// recognisable labels for the seeded providers.
const providersJson = JSON.parse(
  readFileSync(resolve(INDEXER_ROOT, "src/api/data/providers.json"), "utf-8")
) as Array<{ providerId: number; providerName: string }>;

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const account = privateKeyToAccount(DEPLOYER_PK);

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

// Real StakingRegistry signature: registerProvider returns the assigned id.
const stakingRegistryAbi = parseAbi([
  "function registerProvider(address _providerAdmin, uint16 _providerTakeRate, address _providerRewardsRecipient) external returns (uint256)",
  "function nextProviderIdentifier() external view returns (uint256)",
]);

async function main() {
  const toRegister = providersJson.slice(0, 10);

  console.log(`\nRegistering ${toRegister.length} providers on StakingRegistry`);
  console.log(`  StakingRegistry: ${stakingRegistry}`);
  console.log(`  RPC:             ${rpcUrl}\n`);

  const startId = await publicClient.readContract({
    address: stakingRegistry, abi: stakingRegistryAbi, functionName: "nextProviderIdentifier",
  });

  for (const [i, p] of toRegister.entries()) {
    const expectedId = startId + BigInt(i);
    const hash = await walletClient.writeContract({
      address: stakingRegistry,
      abi: stakingRegistryAbi,
      functionName: "registerProvider",
      args: [account.address, 500, account.address], // admin, 5% take rate (bps/100), rewards recipient
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  Registered provider id=${expectedId} (label: ${p.providerName})`);
  }

  console.log(`\nDone. Once the indexer catches up:`);
  console.log(`  curl http://localhost:42068/api/providers | jq '.providers | length'`);
}

main().catch((err) => { console.error(`\nError: ${err.message}\n`); process.exit(1); });
