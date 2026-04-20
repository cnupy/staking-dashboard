# Multi-rollup test environment

End-to-end local environment for testing rollup-upgrade scenarios. Stands up
**real** Aztec L1 contracts on a local anvil chain with two rollup versions
registered in the same Registry, then deploys the **real** StakingRegistry +
ATP factories from `ignition-contracts`. No mocks: every contract is the
exact production bytecode, so storage layouts, ABIs, and event signatures
match testnet/mainnet behaviour.

The intended consumer is the indexer + dashboard pair: point both at this
anvil and the Registry's `CanonicalRollupUpdated` events flow through to
`/api/rollups`, ATP staking events flow through to `/api/atp` and
`/api/providers`, and the dashboard sees the same shape of data it would in
production, but with two rollups instead of one.

## What it does

1. **Phase 0**: `anvil_setCode` to deploy Multicall3 at its canonical
   address. wagmi's `useReadContracts` requires it; anvil doesn't deploy it
   by default.
2. **Phase 1**: runs `aztec-packages/l1-contracts/script/deploy/DeployAztecL1Contracts.s.sol`
   against anvil. Deploys Registry, GSE, Governance, RewardDistributor,
   MockVerifier, TestERC20s (staking + fee assets), Rollup v1.
3. **Phase 2**: runs `DeployRollupForUpgrade.s.sol` with a fresh random
   `GENESIS_ARCHIVE_ROOT`, producing a Rollup v2 with a different version hash.
4. **Phase 3**: `anvil_impersonateAccount` Governance (which owns the Registry
   after handover) and calls `Registry.addRollup(v2)`. Also best-effort
   registers v2 in the GSE.
5. **Phase 4**: deploys the real `StakingRegistry`, `PullSplitFactory`,
   `ATPFactory`, and `ATPWithdrawableAndClaimableStaker` from
   `ignition-contracts/`, wired together with the real staking asset and
   Registry from Phase 1. Configures `setMinter` and registers the staker
   implementation with the ATP registry.
6. **Output**: writes `deploy-output.json` (every address, useful for the
   seed scripts and assertions) and `contract_addresses.json` (the format
   `atp-indexer/bootstrap.sh` and `staking-dashboard/bootstrap.sh` already
   read).

`seed-multi-rollup.ts` then writes sequencer reward state via
`anvil_setStorageAt` (using the Rollup's ERC-7201 namespaced storage layout)
and mints fee tokens to both rollups so `claimSequencerRewards` can actually
pay out. `seed-providers.ts` registers a handful of providers on the real
StakingRegistry so the indexer's `/api/providers` endpoint isn't empty.

## Prerequisites

- **Node.js 20+** and **yarn 1.22**
- **Foundry** (`forge`, `anvil`, `cast`): `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **yq**: `brew install yq` (used to load network defaults)
- **`aztec-packages`** repo cloned somewhere; set `AZTEC_PACKAGES_DIR` (auto-detected if it sits at `../aztec-packages` relative to this repo)
- **`ignition-contracts`** repo cloned somewhere; set `IGNITION_CONTRACTS_DIR` (auto-detected at `../ignition-contracts`)
- Both `aztec-packages/l1-contracts` and `ignition-contracts` need to compile
  cleanly with `forge build` (the deploy script runs both)

## Quick start

```bash
# Terminal 1: anvil
anvil --port 8545

# Terminal 2: deploy contracts (~2 min on a cold compile, ~30s warm)
bash staking-dashboard/scripts/multi-rollup-test/deploy-multi-rollup.sh

# Seed rewards + fee tokens
npx tsx staking-dashboard/scripts/multi-rollup-test/seed-multi-rollup.ts

# (optional) seed providers so /api/providers returns data
npx tsx staking-dashboard/scripts/multi-rollup-test/seed-providers.ts
```

After deploy, the script prints two `export` lines that point both bootstraps
at the generated `contract_addresses.json`. Copy them into the terminals
running the indexer and dashboard:

```bash
export CONTRACT_ADDRESSES_FILE=$(pwd)/staking-dashboard/scripts/multi-rollup-test/contract_addresses.json
export RPC_URL=http://127.0.0.1:8545

# Terminal 3: indexer
cd atp-indexer && ./bootstrap.sh dev

# Terminal 4: dashboard
cd staking-dashboard && ./bootstrap.sh dev
```

Verify the indexer picked up both rollups:

```bash
curl http://localhost:42068/api/rollups | jq
# {
#   "canonical": "0x...",     <- Rollup v2
#   "versions": [
#     {"version": "...", "address": "0x...", ...},   <- Rollup v1
#     {"version": "...", "address": "0x...", ...}    <- Rollup v2
#   ]
# }
```

## Test data matrix

| Data point | Rollup v1 | Rollup v2 |
|---|---|---|
| `getVersion()` | auto from genesis | different hash (different genesis archive root) |
| `isRewardsClaimable()` | true | true |
| `getSequencerRewards(coinbaseA)` | 5e18 | 10e18 |
| `getSequencerRewards(coinbaseB)` | 3e18 | 0 |

- **coinbaseA**: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (anvil account 1)
- **coinbaseB**: `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` (anvil account 2)

## File outputs

| File | Purpose |
|---|---|
| `deploy-output.json` | Every deployed address + chain id + RPC URL. Consumed by both seed scripts. |
| `contract_addresses.json` | Schema expected by `bootstrap.sh` in both apps. Consumed via `CONTRACT_ADDRESSES_FILE`. |
| `test-data.json` | What `seed-multi-rollup.ts` actually wrote, useful for assertion-driven tests. |

## Architecture

```
anvil (port 8545)
  ├── Real Registry (from aztec-packages)
  │     ├── Rollup v1 (older)
  │     └── Rollup v2 (canonical)
  ├── Real GSE, Governance, RewardDistributor, MockVerifier
  ├── Real TestERC20 (staking asset) + TestERC20 (fee asset)
  ├── Real PullSplitFactory (Splits v2)
  ├── Real StakingRegistry (from ignition-contracts)
  └── Real ATPFactory + ATPRegistry + ATPWithdrawableAndClaimableStaker

Indexer (port 42068)
  └── Indexes from REGISTRY_DEPLOYMENT_BLOCK
        ├── Registry:CanonicalRollupUpdated → rollup_version table → /api/rollups
        ├── Rollup events (factory pattern across both rollups)
        ├── StakingRegistry events (provider registrations, stakes)
        └── ATP events (positions, operator updates)

Dashboard (port 5173)
  └── Boot-time fetch of /api/rollups; canonical = v2
```

## Gotchas

### MetaMask "nonce too low" after restarting anvil

**Symptom**: transactions fail with "Nonce provided for the transaction (N) is lower than the current nonce".

**Cause**: MetaMask caches the per-account nonce. After restarting anvil or
re-running the deploy script, the on-chain nonce resets but MetaMask doesn't
know.

**Fix**: MetaMask → Settings → Advanced → **Clear activity tab data**.

### `claimSequencerRewards` reverts with `ERC20InsufficientBalance`

**Symptom**: simulating the claim fails because the Rollup contract has 0
balance of the fee asset.

**Cause**: rewards are paid out by transferring **fee asset** (not staking
asset) from the Rollup's own balance. Setting the reward storage slot to N
doesn't give the Rollup any tokens.

**Fix**: `seed-multi-rollup.ts` mints fee tokens to both rollups. If you see
the error after a fresh deploy, re-run `seed-multi-rollup.ts`.

### Multicall3 not deployed → wagmi `useReadContracts` returns nothing

**Symptom**: per-rollup hooks silently return empty data.

**Cause**: wagmi's `useReadContracts` calls Multicall3 at the canonical
address `0xcA11bde05977b3631167028862bE2a173976CA11`. Anvil doesn't deploy
it by default.

**Fix**: Phase 0 of the deploy script `anvil_setCode`s the Multicall3
deployedBytecode in. If you restart anvil, re-run the deploy script.

### `aztec-packages/l1-contracts` won't compile (missing `HonkVerifier.sol`)

**Symptom**: `forge build` fails with "Source not found: generated/HonkVerifier.sol".

**Cause**: `HonkVerifier.sol` is generated from noir circuit compilation. We
use `MockVerifier` at runtime so the real one isn't needed, but the import
path still has to resolve.

**Fix**: Phase 0 of the deploy script writes a no-op placeholder if it
doesn't exist. If compiling `aztec-packages/l1-contracts` manually:

```bash
cd $AZTEC_PACKAGES_DIR/l1-contracts
mkdir -p generated
cat > generated/HonkVerifier.sol << 'EOF'
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
contract HonkVerifier is IVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure override returns (bool) { return true; }
}
EOF
```

### Storage slot calculation for rewards (ERC-7201)

The Rollup uses **namespaced storage** (ERC-7201). Reward data lives at:

```
base = keccak256("aztec.reward.storage")  // raw UTF-8 bytes, NOT abi.encode

RewardStorage layout (relative to base):
  slot 0: mapping(address => uint256) sequencerRewards
  slot 1: mapping(Epoch => EpochRewards) epochRewards
  slot 2: mapping(address => BitMap) proverClaimed
  slot 3-4: RewardConfig struct
  slot 5: bytes4 earliestRewardsClaimableTimestamp || bool isRewardsClaimable
```

For a mapping entry: `keccak256(abi.encode(addressKey, base + 0))`. For
`isRewardsClaimable`: set bit at byte offset 4 (after the 4-byte timestamp)
of slot `base + 5`.

Common mistake: `keccak256(abi.encode("aztec.reward.storage"))` (encoded
string with offset+length prefix) instead of `keccak256("aztec.reward.storage")`
(raw bytes). The two produce different hashes and the former silently writes
to the wrong slot.

### Governance owns the Registry, direct `addRollup` reverts

**Symptom**: deploying rollup v2 succeeds but `Registry.addRollup(v2)` reverts
with an ownership error from the deployer EOA.

**Cause**: `DeployAztecL1Contracts` transfers Registry ownership to Governance
in `_handoverToGovernance()`. After that, only Governance can call
`addRollup()`.

**Fix**: Phase 3 of the deploy script uses `anvil_impersonateAccount` to act
as Governance for the registration call. This only works on anvil; on a
real network you'd go through the governance proposal flow.

### Indexer shows empty `/api/rollups` until backfill catches up

**Symptom**: dashboard fails to boot with "Indexer has not yet recorded a
canonical rollup" right after a fresh deploy.

**Cause**: the indexer only populates `rollup_version` after it indexes the
first `CanonicalRollupUpdated` event, which lives at the Registry deployment
block. There's a brief window where backfill hasn't caught up.

**Fix**: wait for the indexer to backfill past the Registry deployment block
(usually seconds against a local anvil). Refresh the dashboard.
