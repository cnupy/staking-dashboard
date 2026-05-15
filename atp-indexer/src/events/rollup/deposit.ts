import { ponder } from "ponder:registry";
import { normalizeAddress } from "../../utils/address";
import { deposit } from "ponder:schema";
import { decodeMoveWithRollup } from "../../utils/move-with-rollup";

/**
 * Handle Deposit event from Rollup contract.
 * Records successful validator deposits with BLS keys.
 *
 * Also captures `moveWithRollup` from the originating tx's calldata (not in
 * the event payload, but recoverable from the call args) so the dashboard
 * can resolve which rollup currently holds the live stake without an
 * on-chain probe. `effectiveRollup` starts equal to the deposit rollup;
 * the canonical-rollup-updated handler later rewrites it for rows where
 * `moveWithRollup = true`.
 */
ponder.on("Rollup:Deposit", async ({ event, context }) => {
  const { attester, withdrawer, publicKeyInG1, publicKeyInG2, proofOfPossession, amount } =
    event.args;
  const { db } = context;

  const depositRollup = normalizeAddress(event.log.address) as `0x${string}`;
  const moveWithRollup = decodeMoveWithRollup(event.transaction.input);

  await db.insert(deposit).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    attesterAddress: normalizeAddress(attester) as `0x${string}`,
    withdrawerAddress: normalizeAddress(withdrawer) as `0x${string}`,
    rollupAddress: depositRollup,
    publicKeyG1X: publicKeyInG1.x,
    publicKeyG1Y: publicKeyInG1.y,
    publicKeyG2X0: publicKeyInG2.x0,
    publicKeyG2X1: publicKeyInG2.x1,
    publicKeyG2Y0: publicKeyInG2.y0,
    publicKeyG2Y1: publicKeyInG2.y1,
    proofOfPossessionX: proofOfPossession.x,
    proofOfPossessionY: proofOfPossession.y,
    amount,
    moveWithRollup,
    effectiveRollup: depositRollup,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  })

  console.log(
    `Deposit recorded: attester ${attester}, withdrawer ${withdrawer}, amount ${amount}, moveWithRollup=${moveWithRollup}`
  );
});
