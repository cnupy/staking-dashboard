/**
 * Seed multi-rollup test state on local anvil.
 *
 * After deploy-multi-rollup.sh has stood up the contracts, this script:
 *   1. Writes sequencer reward amounts via anvil_setStorageAt on both rollups
 *      (uses the real Rollup's ERC-7201 namespaced reward storage layout)
 *   2. Flips isRewardsClaimable to true on both rollups
 *   3. Mints fee tokens to each rollup so claimSequencerRewards() can pay out
 *   4. Writes test-data.json describing what was seeded (handy for assertions)
 *
 * Run from repo root:
 *   npx tsx staking-dashboard/scripts/multi-rollup-test/seed-multi-rollup.ts
 */

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  pad,
  numberToHex,
  stringToHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;

const deployOutput = JSON.parse(
  readFileSync(resolve(SCRIPT_DIR, "deploy-output.json"), "utf-8")
);

const rpcUrl = deployOutput.rpcUrl || "http://127.0.0.1:8545";

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const account = privateKeyToAccount(DEPLOYER_PK);
const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

const erc20Abi = parseAbi(["function mint(address _to, uint256 _amount) external"]);

// Anvil default accounts 1 and 2; convenient as test coinbases.
const COINBASE_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const COINBASE_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

// Rollup uses ERC-7201 namespaced storage. Base slot is the keccak256 hash of
// the raw UTF-8 string (NOT the abi-encoded string, which produces a different
// hash). RewardStorage layout relative to base:
//   slot 0: mapping(address => uint256) sequencerRewards
//   slot 5: bytes4 earliestRewardsClaimableTimestamp || bool isRewardsClaimable
const REWARD_STORAGE_BASE = keccak256(stringToHex("aztec.reward.storage"));
const SEQUENCER_REWARDS_SLOT = BigInt(REWARD_STORAGE_BASE);
const IS_CLAIMABLE_SLOT = BigInt(REWARD_STORAGE_BASE) + 5n;

function mappingSlot(key: Address, baseSlot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, baseSlot]));
}

async function setStorageSlot(contract: Address, slot: Hex, value: Hex): Promise<void> {
  await testClient.setStorageAt({ address: contract, index: slot, value: pad(value, { size: 32 }) });
}

const rollupAbi = [
  { type: "function", name: "getSequencerRewards", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isRewardsClaimable", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getVersion", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

async function main() {
  const rollupV1 = deployOutput.rollupV1Address as Address;
  const rollupV2 = deployOutput.rollupV2Address as Address;
  const feeAsset = deployOutput.feeAssetAddress as Address;

  console.log(`\nSeeding multi-rollup test state`);
  console.log(`  Rollup v1: ${rollupV1}`);
  console.log(`  Rollup v2: ${rollupV2}`);
  console.log(`  RPC:       ${rpcUrl}\n`);

  console.log("Setting sequencer rewards...");
  await setStorageSlot(rollupV1, mappingSlot(COINBASE_A, SEQUENCER_REWARDS_SLOT), numberToHex(5n * 10n ** 18n, { size: 32 }));
  await setStorageSlot(rollupV1, mappingSlot(COINBASE_B, SEQUENCER_REWARDS_SLOT), numberToHex(3n * 10n ** 18n, { size: 32 }));
  await setStorageSlot(rollupV2, mappingSlot(COINBASE_A, SEQUENCER_REWARDS_SLOT), numberToHex(10n * 10n ** 18n, { size: 32 }));

  // Flip isRewardsClaimable without clobbering the packed timestamp at offset 0.
  console.log("Setting isRewardsClaimable = true on both rollups...");
  for (const rollup of [rollupV1, rollupV2]) {
    const currentVal = await publicClient.getStorageAt({
      address: rollup,
      slot: numberToHex(IS_CLAIMABLE_SLOT, { size: 32 }),
    });
    const withClaimable = BigInt(currentVal || "0x0") | (1n << 32n); // bool sits at byte offset 4 (after the 4-byte timestamp)
    await setStorageSlot(rollup, numberToHex(IS_CLAIMABLE_SLOT, { size: 32 }), numberToHex(withClaimable, { size: 32 }));
  }

  // claimSequencerRewards transfers the fee asset from the rollup's own balance.
  // Without this mint the claim tx reverts with ERC20InsufficientBalance.
  console.log("Minting fee tokens to both rollups for claim payouts...");
  const mintAmount = 1000n * 10n ** 18n;
  for (const rollup of [rollupV1, rollupV2]) {
    const hash = await walletClient.writeContract({
      address: feeAsset, abi: erc20Abi, functionName: "mint", args: [rollup, mintAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  console.log(`  Minted 1000 FEE to each rollup`);

  console.log("\nVerifying...");
  const v1RewardsA = await publicClient.readContract({ address: rollupV1, abi: rollupAbi, functionName: "getSequencerRewards", args: [COINBASE_A] });
  const v1RewardsB = await publicClient.readContract({ address: rollupV1, abi: rollupAbi, functionName: "getSequencerRewards", args: [COINBASE_B] });
  const v2RewardsA = await publicClient.readContract({ address: rollupV2, abi: rollupAbi, functionName: "getSequencerRewards", args: [COINBASE_A] });
  const v1Claimable = await publicClient.readContract({ address: rollupV1, abi: rollupAbi, functionName: "isRewardsClaimable" });
  const v2Claimable = await publicClient.readContract({ address: rollupV2, abi: rollupAbi, functionName: "isRewardsClaimable" });
  const v1Version = await publicClient.readContract({ address: rollupV1, abi: rollupAbi, functionName: "getVersion" });
  const v2Version = await publicClient.readContract({ address: rollupV2, abi: rollupAbi, functionName: "getVersion" });

  console.log(`  v1 rewards A: ${v1RewardsA} (expected ${5n * 10n ** 18n})`);
  console.log(`  v1 rewards B: ${v1RewardsB} (expected ${3n * 10n ** 18n})`);
  console.log(`  v2 rewards A: ${v2RewardsA} (expected ${10n * 10n ** 18n})`);
  console.log(`  v1 isRewardsClaimable: ${v1Claimable}, v2 isRewardsClaimable: ${v2Claimable}`);
  if (v1RewardsA !== 5n * 10n ** 18n || v2RewardsA !== 10n * 10n ** 18n || !v1Claimable || !v2Claimable) {
    console.error("  Verification mismatch: storage slot calculation may be off");
    process.exit(1);
  }

  const testData = {
    ...deployOutput,
    rollupV1Version: v1Version.toString(),
    rollupV2Version: v2Version.toString(),
    coinbaseA: COINBASE_A,
    coinbaseB: COINBASE_B,
    rollupV1Rewards: { [COINBASE_A]: (5n * 10n ** 18n).toString(), [COINBASE_B]: (3n * 10n ** 18n).toString() },
    rollupV2Rewards: { [COINBASE_A]: (10n * 10n ** 18n).toString() },
    rewardsClaimable: { [rollupV1]: v1Claimable, [rollupV2]: v2Claimable },
  };
  writeFileSync(resolve(SCRIPT_DIR, "test-data.json"), JSON.stringify(testData, null, 2));
  console.log(`\nWrote ${resolve(SCRIPT_DIR, "test-data.json")}`);

  // Frontend gating: the Claimable Rewards section requires the user to have
  // saved coinbase addresses. Rather than walking the UI, paste this into
  // DevTools to populate localStorage and reload.
  const DEPLOYER_ADDR = account.address.toLowerCase();
  const lsKey = `rewards_coinbase_addresses_${DEPLOYER_ADDR}`;
  const lsValue = JSON.stringify([COINBASE_A.toLowerCase()]);
  console.log("\nBrowser setup (paste in DevTools console):");
  console.log(`  localStorage.setItem('${lsKey}', '${lsValue}'); location.reload();`);
}

main().catch((err) => { console.error(`\nError: ${err.message}\n`); process.exit(1); });
