#!/bin/bash
# Deploy a complete real-contract multi-rollup test environment to local anvil.
#
# Stands up the same Aztec L1 stack used in production (Registry, Governance,
# GSE, Rollup v1, RewardDistributor, MockVerifier, TestERC20s) plus a second
# canonical rollup, then deploys the real StakingRegistry and ATP factories
# from the ignition-contracts repo. No mocks: every contract is the production
# bytecode, so storage layouts, ABIs, and event signatures match exactly what
# the indexer and frontend see on testnet/mainnet.
#
# Required env vars:
#   AZTEC_PACKAGES_DIR      path to aztec-packages repo
#   IGNITION_CONTRACTS_DIR  path to ignition-contracts repo
#
# Optional env vars:
#   ANVIL_PORT  (default 8545)
#   DEPLOYER_PK (default anvil account 0)
#
# Output: scripts/multi-rollup-test/contract_addresses.json + deploy-output.json
# Both consumed by the indexer/frontend bootstrap.sh via CONTRACT_ADDRESSES_FILE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."
OUT_DIR="$SCRIPT_DIR"

AZTEC_PACKAGES_DIR="${AZTEC_PACKAGES_DIR:-}"
IGNITION_CONTRACTS_DIR="${IGNITION_CONTRACTS_DIR:-}"

# Auto-detect sibling repos if env vars not set
if [ -z "$AZTEC_PACKAGES_DIR" ] && [ -d "$REPO_ROOT/../aztec-packages/l1-contracts" ]; then
  AZTEC_PACKAGES_DIR="$(cd "$REPO_ROOT/../aztec-packages" && pwd)"
fi
if [ -z "$IGNITION_CONTRACTS_DIR" ] && [ -d "$REPO_ROOT/../ignition-contracts/src" ]; then
  IGNITION_CONTRACTS_DIR="$(cd "$REPO_ROOT/../ignition-contracts" && pwd)"
fi

[ -n "$AZTEC_PACKAGES_DIR" ] || { echo "ERROR: AZTEC_PACKAGES_DIR not set and ../aztec-packages not found"; exit 1; }
[ -n "$IGNITION_CONTRACTS_DIR" ] || { echo "ERROR: IGNITION_CONTRACTS_DIR not set and ../ignition-contracts not found"; exit 1; }
[ -d "$AZTEC_PACKAGES_DIR/l1-contracts/src" ] || { echo "ERROR: $AZTEC_PACKAGES_DIR/l1-contracts/src not found"; exit 1; }
[ -d "$IGNITION_CONTRACTS_DIR/src/staking-registry" ] || { echo "ERROR: $IGNITION_CONTRACTS_DIR/src/staking-registry not found"; exit 1; }

L1_ROOT="$AZTEC_PACKAGES_DIR/l1-contracts"
ANVIL_PORT="${ANVIL_PORT:-8545}"
L1_RPC_URL="http://127.0.0.1:$ANVIL_PORT"
DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_PK")

# Sanity: anvil reachable
cast block-number --rpc-url "$L1_RPC_URL" > /dev/null 2>&1 || {
  echo "ERROR: anvil not reachable at $L1_RPC_URL. Start it first: anvil --port $ANVIL_PORT"; exit 1;
}

rm -f "$OUT_DIR/deploy-output.json" "$OUT_DIR/contract_addresses.json"

echo "=== Loading devnet defaults ==="
# shellcheck disable=SC1091
source "$L1_ROOT/scripts/load_network_defaults.sh" devnet 2>/dev/null
export L1_RPC_URL
export ROLLUP_DEPLOYMENT_PRIVATE_KEY="$DEPLOYER_PK"
export REAL_VERIFIER=false

# ============================================================
# Phase 0: l1-contracts compile prep + Multicall3
# ============================================================
echo ""
echo "=== Phase 0: Preparing l1-contracts + Multicall3 ==="
cd "$L1_ROOT"
mkdir -p generated

# HonkVerifier is generated from circuits at proper builds. We use MockVerifier
# at runtime, but the import still has to resolve at compile time.
if [ ! -f generated/HonkVerifier.sol ]; then
  cat > generated/HonkVerifier.sol << 'SOLEOF'
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
contract HonkVerifier is IVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure override returns (bool) { return true; }
}
SOLEOF
fi
if [ ! -f generated/default.json ]; then
  yq -o json 'explode(.) | ."l1-contracts" // {}' "$AZTEC_PACKAGES_DIR/spartan/environments/network-defaults.yml" > generated/default.json 2>/dev/null || echo "{}" > generated/default.json
fi

# foundry.toml pins solc to a local binary (./solc-0.8.30) that's normally
# fetched by aztec-packages' own bootstrap.sh. If it isn't there, fall back
# to forge's built-in svm so this script works against a fresh checkout.
SOLC_PATH=$(grep '^solc = ' foundry.toml 2>/dev/null | sed 's/.*"\.\/\(.*\)"/\1/' || true)
if [ -n "$SOLC_PATH" ] && [ ! -f "./$SOLC_PATH" ]; then
  SOLC_VERSION=${SOLC_PATH#solc-}
  echo "  ./$SOLC_PATH missing, fetching solc $SOLC_VERSION via svm"
  mkdir -p "$HOME/.svm"
  forge build --use "$SOLC_VERSION" src/core/libraries/ConstantsGen.sol > /dev/null 2>&1 || true
  SVM_BIN="$HOME/.svm/$SOLC_VERSION/solc-$SOLC_VERSION"
  if [ -f "$SVM_BIN" ]; then
    cp "$SVM_BIN" "./$SOLC_PATH"
  else
    echo "  ERROR: failed to obtain solc $SOLC_VERSION via svm"; exit 1
  fi
fi

forge build > /dev/null

# Multicall3 deploy via setCode. wagmi useReadContracts depends on it; anvil
# does not deploy it by default.
MULTICALL3_BYTECODE=$(jq -r '.deployedBytecode.object' "$L1_ROOT/out/Multicall3.sol/Multicall3.json" 2>/dev/null || true)
if [ -n "$MULTICALL3_BYTECODE" ] && [ "$MULTICALL3_BYTECODE" != "null" ]; then
  cast rpc anvil_setCode "0xcA11bde05977b3631167028862bE2a173976CA11" "$MULTICALL3_BYTECODE" --rpc-url "$L1_RPC_URL" > /dev/null
  echo "  Multicall3 deployed at 0xcA11bde05977b3631167028862bE2a173976CA11"
else
  echo "  WARN: Multicall3 bytecode not found; wagmi useReadContracts may fail"
fi

rm -rf broadcast/

# ============================================================
# Phase 1: full L1 stack + rollup v1
# ============================================================
echo ""
echo "=== Phase 1: Deploying L1 stack + Rollup v1 ==="

forge script script/deploy/DeployAztecL1Contracts.s.sol:DeployAztecL1Contracts \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$DEPLOYER_PK" \
  --broadcast > /tmp/deploy_v1.log 2>&1

# Pull the JSON result line emitted by the deploy script (search anywhere in the log)
DEPLOY_JSON=$(grep -A1 "JSON DEPLOY RESULT:" /tmp/deploy_v1.log | tail -1)
[ -n "$DEPLOY_JSON" ] || DEPLOY_JSON=$(grep "JSON DEPLOY RESULT:" /tmp/deploy_v1.log | sed 's/.*JSON DEPLOY RESULT://')

REGISTRY=$(echo "$DEPLOY_JSON" | jq -r '.registryAddress')
ROLLUP_V1=$(echo "$DEPLOY_JSON" | jq -r '.rollupAddress')
STAKING_ASSET=$(echo "$DEPLOY_JSON" | jq -r '.stakingAssetAddress')
FEE_ASSET=$(echo "$DEPLOY_JSON" | jq -r '.feeAssetAddress')
GOVERNANCE=$(echo "$DEPLOY_JSON" | jq -r '.governanceAddress')
GSE_ADDR=$(echo "$DEPLOY_JSON" | jq -r '.gseAddress')
REWARD_DIST=$(echo "$DEPLOY_JSON" | jq -r '.rewardDistributorAddress')
V1_VERSION=$(echo "$DEPLOY_JSON" | jq -r '.rollupVersion')

[ -n "$REGISTRY" ] && [ "$REGISTRY" != "null" ] || { echo "ERROR: failed to parse Registry address from deploy output"; cat /tmp/deploy_v1.log; exit 1; }

# Capture Registry deployment block (needed by the indexer factory backfill).
REGISTRY_BLOCK=$(cast code --rpc-url "$L1_RPC_URL" "$REGISTRY" > /dev/null && \
  cast block-number --rpc-url "$L1_RPC_URL")
# Refine: walk backwards to find the actual deploy block. Simpler: use current
# block number minus a small buffer, since anvil started fresh.
REGISTRY_BLOCK=$(cast logs --rpc-url "$L1_RPC_URL" --address "$REGISTRY" --from-block 0 \
  'CanonicalRollupUpdated(address,uint256)' --json 2>/dev/null \
  | jq -r '.[0].blockNumber' | sed 's/0x//' | tr '[:lower:]' '[:upper:]' \
  | xargs -I{} printf '%d\n' "0x{}" 2>/dev/null || echo "0")

echo "  Registry:      $REGISTRY (deploy block ~$REGISTRY_BLOCK)"
echo "  Rollup v1:     $ROLLUP_V1 (version $V1_VERSION)"
echo "  Staking asset: $STAKING_ASSET"
echo "  Fee asset:     $FEE_ASSET"
echo "  Governance:    $GOVERNANCE"

# ============================================================
# Phase 2: rollup v2 with a different genesis
# ============================================================
echo ""
echo "=== Phase 2: Deploying Rollup v2 ==="

# Different genesis archive root → different version hash → addRollup() accepts it
export GENESIS_ARCHIVE_ROOT="0x$(openssl rand -hex 32)"
export REGISTRY_ADDRESS="$REGISTRY"

forge script script/deploy/DeployRollupForUpgrade.s.sol:DeployRollupForUpgrade \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$DEPLOYER_PK" \
  --broadcast > /tmp/deploy_v2.log 2>&1

DEPLOY_V2_JSON=$(grep -A1 "JSON DEPLOY RESULT:" /tmp/deploy_v2.log | tail -1)
[ -n "$DEPLOY_V2_JSON" ] || DEPLOY_V2_JSON=$(grep "JSON DEPLOY RESULT:" /tmp/deploy_v2.log | sed 's/.*JSON DEPLOY RESULT://')

ROLLUP_V2=$(echo "$DEPLOY_V2_JSON" | jq -r '.rollupAddress')
V2_VERSION=$(echo "$DEPLOY_V2_JSON" | jq -r '.rollupVersion')
echo "  Rollup v2:     $ROLLUP_V2 (version $V2_VERSION)"

# ============================================================
# Phase 3: register rollup v2 (Governance owns Registry post-handover)
# ============================================================
echo ""
echo "=== Phase 3: Registering Rollup v2 in Registry ==="
cast rpc anvil_impersonateAccount "$GOVERNANCE" --rpc-url "$L1_RPC_URL" > /dev/null
cast rpc anvil_setBalance "$GOVERNANCE" "0xDE0B6B3A7640000" --rpc-url "$L1_RPC_URL" > /dev/null
cast send "$REGISTRY" "addRollup(address)" "$ROLLUP_V2" \
  --from "$GOVERNANCE" --rpc-url "$L1_RPC_URL" --unlocked > /dev/null
# Best-effort GSE registration; older GSE versions may not have addRollup
cast send "$GSE_ADDR" "addRollup(address)" "$ROLLUP_V2" \
  --from "$GOVERNANCE" --rpc-url "$L1_RPC_URL" --unlocked > /dev/null 2>&1 || true
cast rpc anvil_stopImpersonatingAccount "$GOVERNANCE" --rpc-url "$L1_RPC_URL" > /dev/null

NUM_VERSIONS=$(cast call "$REGISTRY" "numberOfVersions()(uint256)" --rpc-url "$L1_RPC_URL")
CANONICAL=$(cast call "$REGISTRY" "getCanonicalRollup()(address)" --rpc-url "$L1_RPC_URL")
echo "  Versions registered: $NUM_VERSIONS"
echo "  Canonical rollup:    $CANONICAL"

# ============================================================
# Phase 4: real StakingRegistry + ATP factories from ignition-contracts
# ============================================================
echo ""
echo "=== Phase 4: Deploying real StakingRegistry + ATP factories ==="
cd "$IGNITION_CONTRACTS_DIR"
forge build > /dev/null

# 4a: SplitsWarehouse (Splits v2 dependency). Constructor: (nativeName, nativeSymbol)
echo "  Deploying SplitsWarehouse..."
SPLITS_WAREHOUSE=$(forge create \
  lib/splits-contracts-monorepo/packages/splits-v2/src/SplitsWarehouse.sol:SplitsWarehouse \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "Ether" "ETH" 2>/dev/null \
  | awk '/Deployed to:/ {print $3}')
[ -n "$SPLITS_WAREHOUSE" ] || { echo "ERROR: SplitsWarehouse deploy failed"; exit 1; }
echo "    SplitsWarehouse: $SPLITS_WAREHOUSE"

# 4b: PullSplitFactory. Constructor: (splitsWarehouse)
echo "  Deploying PullSplitFactory..."
PULL_SPLIT_FACTORY=$(forge create \
  lib/splits-contracts-monorepo/packages/splits-v2/src/splitters/pull/PullSplitFactory.sol:PullSplitFactory \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "$SPLITS_WAREHOUSE" 2>/dev/null \
  | awk '/Deployed to:/ {print $3}')
[ -n "$PULL_SPLIT_FACTORY" ] || { echo "ERROR: PullSplitFactory deploy failed"; exit 1; }
echo "    PullSplitFactory: $PULL_SPLIT_FACTORY"

# 4c: real StakingRegistry. Constructor: (stakingAsset, pullSplitFactory, registry)
echo "  Deploying StakingRegistry..."
STAKING_REGISTRY=$(forge create \
  src/staking-registry/StakingRegistry.sol:StakingRegistry \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "$STAKING_ASSET" "$PULL_SPLIT_FACTORY" "$REGISTRY" 2>/dev/null \
  | awk '/Deployed to:/ {print $3}')
[ -n "$STAKING_REGISTRY" ] || { echo "ERROR: StakingRegistry deploy failed"; exit 1; }
echo "    StakingRegistry: $STAKING_REGISTRY"

# 4d: ATPFactory + its 3 library deps. ATPFactory dispatches to LATPFactory /
# MATPFactory / NCATPFactory deployment libs via DELEGATECALL, so they have to
# be deployed first and linked at compile time.
deploy_lib() {
  local path="$1"
  local addr
  addr=$(forge create "$path" --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
    | awk '/Deployed to:/ {print $3}')
  [ -n "$addr" ] || { echo "ERROR: deploy $path failed"; exit 1; }
  echo "$addr"
}
echo "  Deploying ATPFactory libraries..."
LATP_LIB=$(deploy_lib src/token-vaults/deployment-factories/LATPFactory.sol:LATPFactory)
MATP_LIB=$(deploy_lib src/token-vaults/deployment-factories/MATPFactory.sol:MATPFactory)
NCATP_LIB=$(deploy_lib src/token-vaults/deployment-factories/NCATPFactory.sol:NCATPFactory)
echo "    LATPFactory lib: $LATP_LIB"
echo "    MATPFactory lib: $MATP_LIB"
echo "    NCATPFactory lib: $NCATP_LIB"

echo "  Deploying ATPFactory..."
ATP_FACTORY=$(forge create \
  src/token-vaults/ATPFactory.sol:ATPFactory \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
  --libraries "src/token-vaults/deployment-factories/LATPFactory.sol:LATPFactory:$LATP_LIB" \
  --libraries "src/token-vaults/deployment-factories/MATPFactory.sol:MATPFactory:$MATP_LIB" \
  --libraries "src/token-vaults/deployment-factories/NCATPFactory.sol:NCATPFactory:$NCATP_LIB" \
  --constructor-args "$DEPLOYER_ADDR" "$STAKING_ASSET" "31536000" "31536000" \
  | awk '/Deployed to:/ {print $3}')
[ -n "$ATP_FACTORY" ] || { echo "ERROR: ATPFactory deploy failed"; exit 1; }
echo "    ATPFactory: $ATP_FACTORY"

# 4e: derive ATPRegistry from ATPFactory; configure executable timestamp + minter
ATP_REGISTRY=$(cast call "$ATP_FACTORY" "getRegistry()(address)" --rpc-url "$L1_RPC_URL")
echo "    ATPRegistry: $ATP_REGISTRY (from factory)"
cast send "$ATP_FACTORY" "setMinter(address,bool)" "$DEPLOYER_ADDR" true \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" > /dev/null
cast send "$ATP_REGISTRY" "setExecuteAllowedAt(uint256)" 1 \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" > /dev/null

# 4f: ATPWithdrawableAndClaimableStaker. Constructor:
#     (stakingAsset, rollupRegistry, stakingRegistry, withdrawalTimestamp)
echo "  Deploying ATPWithdrawableAndClaimableStaker..."
NOW=$(cast block --rpc-url "$L1_RPC_URL" latest --json | jq -r '.timestamp' | xargs printf '%d')
EXEC_AT=$((NOW + 86400))
ATP_STAKER=$(forge create \
  src/staking/ATPWithdrawableAndClaimableStaker.sol:ATPWithdrawableAndClaimableStaker \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "$STAKING_ASSET" "$REGISTRY" "$STAKING_REGISTRY" "$EXEC_AT" 2>/dev/null \
  | awk '/Deployed to:/ {print $3}')
[ -n "$ATP_STAKER" ] || { echo "ERROR: ATPWithdrawableAndClaimableStaker deploy failed"; exit 1; }
echo "    ATPWithdrawableAndClaimableStaker: $ATP_STAKER"

cast send "$ATP_REGISTRY" "registerStakerImplementation(address)" "$ATP_STAKER" \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" > /dev/null

# ============================================================
# Phase 5: write outputs consumed by indexer + frontend bootstrap
# ============================================================
echo ""
echo "=== Phase 5: Writing output files ==="

cat > "$OUT_DIR/deploy-output.json" << EOJSON
{
  "rpcUrl": "$L1_RPC_URL",
  "chainId": 31337,
  "registryAddress": "$REGISTRY",
  "registryDeploymentBlock": "$REGISTRY_BLOCK",
  "rollupV1Address": "$ROLLUP_V1",
  "rollupV1Version": "$V1_VERSION",
  "rollupV2Address": "$ROLLUP_V2",
  "rollupV2Version": "$V2_VERSION",
  "stakingAssetAddress": "$STAKING_ASSET",
  "feeAssetAddress": "$FEE_ASSET",
  "governanceAddress": "$GOVERNANCE",
  "gseAddress": "$GSE_ADDR",
  "rewardDistributorAddress": "$REWARD_DIST",
  "pullSplitFactoryAddress": "$PULL_SPLIT_FACTORY",
  "stakingRegistryAddress": "$STAKING_REGISTRY",
  "atpFactoryAddress": "$ATP_FACTORY",
  "atpRegistryAddress": "$ATP_REGISTRY",
  "atpWithdrawableAndClaimableStakerAddress": "$ATP_STAKER",
  "splitsWarehouseAddress": "$SPLITS_WAREHOUSE"
}
EOJSON
echo "  $OUT_DIR/deploy-output.json"

# contract_addresses.json: schema consumed by atp-indexer/bootstrap.sh and
# staking-dashboard/bootstrap.sh. ATP*Auction and ATPFactoryMATP/LATP are not
# deployed in this env; reuse the genesis ATPFactory address as a placeholder
# so the indexer still boots (factory backfill will index the same events twice
# in the worst case).
cat > "$OUT_DIR/contract_addresses.json" << EOJSON
{
  "atpFactory": "$ATP_FACTORY",
  "atpFactoryAuction": "$ATP_FACTORY",
  "atpFactoryMatp": "$ATP_FACTORY",
  "atpFactoryLatp": "$ATP_FACTORY",
  "atpRegistry": "$ATP_REGISTRY",
  "atpRegistryAuction": "$ATP_REGISTRY",
  "stakingRegistry": "$STAKING_REGISTRY",
  "registryAddress": "$REGISTRY",
  "registryDeploymentBlock": "$REGISTRY_BLOCK",
  "atpFactoryDeploymentBlock": "$REGISTRY_BLOCK",
  "atpWithdrawableAndClaimableStaker": "$ATP_STAKER",
  "genesisSequencerSale": "0x0000000000000000000000000000000000000000",
  "governanceAddress": "$GOVERNANCE",
  "gseAddress": "$GSE_ADDR"
}
EOJSON
echo "  $OUT_DIR/contract_addresses.json"

echo ""
echo "=== Deployment complete ==="
echo "  Registry: $REGISTRY ($NUM_VERSIONS rollup versions)"
echo "  Rollup v1 (older): $ROLLUP_V1 (version $V1_VERSION)"
echo "  Rollup v2 (canonical): $ROLLUP_V2 (version $V2_VERSION)"
echo ""
echo "Next steps:"
echo "  1. Seed rewards + fee tokens:  npx tsx $SCRIPT_DIR/seed-multi-rollup.ts"
echo "  2. Seed providers (optional):  npx tsx $SCRIPT_DIR/seed-providers.ts"
echo "  3. Point indexer at this env:"
echo "       export CONTRACT_ADDRESSES_FILE=$OUT_DIR/contract_addresses.json"
echo "       export RPC_URL=$L1_RPC_URL"
echo "       cd atp-indexer && ./bootstrap.sh dev"
echo "  4. Point frontend at the indexer + this env:"
echo "       export CONTRACT_ADDRESSES_FILE=$OUT_DIR/contract_addresses.json"
echo "       cd staking-dashboard && ./bootstrap.sh dev"
