import { db } from "ponder:api";
import { rollupVersion } from "ponder:schema";
import { desc } from "drizzle-orm";
import type { Address, PublicClient } from "viem";
import { getCanonicalRollupFromRegistry } from "../../utils/rollup";

/**
 * Resolve the current canonical rollup address for API handlers.
 *
 * Preferred path: read the most recent row from the rollup_version table,
 * which is populated by the Registry:CanonicalRollupUpdated handler. That's
 * the indexer's own source of truth for canonical rollup upgrades, so there's
 * no reason to re-query the chain on every API request.
 *
 * Fallback path: live Registry RPC call (cached 60s). Only reached during the
 * brief window after a fresh sync when the indexer hasn't yet processed the
 * first CanonicalRollupUpdated event.
 */
export async function getCanonicalRollupAddress(client: PublicClient): Promise<Address> {
  const latest = await db
    .select()
    .from(rollupVersion)
    .orderBy(desc(rollupVersion.blockNumber))
    .limit(1);

  if (latest.length > 0) {
    return latest[0].address as Address;
  }

  return getCanonicalRollupFromRegistry(client);
}
