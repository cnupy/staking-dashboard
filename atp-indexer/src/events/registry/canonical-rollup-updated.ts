import { ponder } from "ponder:registry";
import { rollupVersion } from "ponder:schema";
import { normalizeAddress } from "../../utils/address";

/**
 * Handle CanonicalRollupUpdated event from the Aztec Registry.
 * Every canonical rollup upgrade goes through Registry.addRollup(), which
 * emits this event. We record it so /api/rollups can expose current + history
 * without the frontend or API handlers making their own Registry RPC calls.
 */
ponder.on("Registry:CanonicalRollupUpdated", async ({ event, context }) => {
  const { instance, version } = event.args;
  const { db } = context;

  await db.insert(rollupVersion).values({
    version,
    address: normalizeAddress(instance) as `0x${string}`,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  });

  console.log(
    `Canonical rollup updated: version ${version}, instance ${instance}`
  );
});
