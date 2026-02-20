import type { Context } from 'hono';
import { db } from 'ponder:api';
import { max, count } from 'drizzle-orm';
import { deposit, provider, atpPosition } from 'ponder:schema';
import { getPublicClient } from '../../utils/viem-client';

interface SyncStatusResponse {
  synced: boolean;
  indexedBlock: number;
  chainHead: number;
  behindBlocks: number;
  hasData: boolean;
  timestamp: string;
}

const SYNC_THRESHOLD_BLOCKS = 50;

/**
 * Handle GET /api/sync-status
 * Returns the indexer's sync status by comparing the latest indexed block to the chain head.
 * Used by the blue-green deployment cron to determine when a backup indexer has caught up.
 */
export async function handleSyncStatus(c: Context): Promise<Response> {
  try {
    const client = getPublicClient();

    const [
      chainHeadBlock,
      depositMaxBlock,
      providerMaxBlock,
      atpMaxBlock,
      providerCountResult,
    ] = await Promise.all([
      client.getBlockNumber(),
      db.select({ maxBlock: max(deposit.blockNumber) }).from(deposit),
      db.select({ maxBlock: max(provider.blockNumber) }).from(provider),
      db.select({ maxBlock: max(atpPosition.blockNumber) }).from(atpPosition),
      db.select({ count: count() }).from(provider),
    ]);

    const chainHead = Number(chainHeadBlock);

    // Take the highest block number across all tables
    const maxBlocks = [
      depositMaxBlock[0]?.maxBlock,
      providerMaxBlock[0]?.maxBlock,
      atpMaxBlock[0]?.maxBlock,
    ]
      .filter((b): b is bigint => b !== null && b !== undefined)
      .map(Number);

    const indexedBlock = maxBlocks.length > 0 ? Math.max(...maxBlocks) : 0;
    const hasData = Number(providerCountResult[0].count) > 0;
    const behindBlocks = chainHead - indexedBlock;
    const synced = behindBlocks < SYNC_THRESHOLD_BLOCKS && hasData;

    const response: SyncStatusResponse = {
      synced,
      indexedBlock,
      chainHead,
      behindBlocks,
      hasData,
      timestamp: new Date().toISOString(),
    };

    return c.json(response);
  } catch (error) {
    console.error('Sync status check failed:', error);
    return c.json(
      {
        synced: false,
        indexedBlock: 0,
        chainHead: 0,
        behindBlocks: -1,
        hasData: false,
        timestamp: new Date().toISOString(),
        error: 'Failed to check sync status',
      },
      500
    );
  }
}
