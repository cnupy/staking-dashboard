import { ponder } from "ponder:registry";
import { normalizeAddress } from "../../utils/address";
import { staked, atpPosition } from "ponder:schema";
import { getActivationThreshold } from "../../utils/rollup";
import { decodeMoveWithRollup } from "../../utils/move-with-rollup";

ponder.on("Staker:Staked", async ({ event, context }) => {
  const { staker, attester, rollup } = event.args;
  const { db, client } = context;

  const stakerAddress = normalizeAddress(staker) as `0x${string}`;

  // Find ATP position by staker address
  const atp = await db.sql.query.atpPosition.findFirst({
    where: (table, { eq }) => eq(atpPosition.stakerAddress, stakerAddress)
  })

  if (!atp) {
    console.warn(`ATP position not found for staker ${stakerAddress}, skipping Staked event`);
    return;
  }

  const activationThreshold = await getActivationThreshold(rollup, client);

  const rollupAddress = normalizeAddress(rollup) as `0x${string}`;
  // `moveWithRollup` is an arg of the originating tx (e.g.
  // StakingRegistry.stake / Staker.stake), not in this Staked event.
  // Decode from calldata; null means the entry point isn't one we
  // recognise and the dashboard should fall back to the on-chain probe.
  const moveWithRollup = decodeMoveWithRollup(event.transaction.input);

  await db.insert(staked).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    atpAddress: normalizeAddress(atp.address) as `0x${string}`,
    stakerAddress,
    stakedAmount: BigInt(activationThreshold),
    operatorAddress: normalizeAddress(atp.operatorAddress || atp.address) as `0x${string}`,
    attesterAddress: normalizeAddress(attester) as `0x${string}`,
    rollupAddress,
    moveWithRollup,
    effectiveRollup: rollupAddress,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  })

  console.log(`Staked (validator creation): staker=${stakerAddress}, operator=${atp.operatorAddress}, attester=${attester}, rollup=${rollup}`);
});
