import type { Context } from 'hono';
import { db } from 'ponder:api';
import { count } from 'drizzle-orm';
import { provider } from 'ponder:schema';
import { getIndexerProgress } from '../utils/indexer-progress';

interface SyncStatusResponse {
  synced: boolean;
  indexedBlock: number;
  chainHead: number;
  behindBlocks: number;
  hasData: boolean;
  timestamp: string;
}

const SYNC_THRESHOLD_BLOCKS = 10;

/**
 * Handle GET /api/sync-status
 * Returns the indexer's sync status by comparing the latest indexed block to the chain head.
 * Used by the blue-green deployment cron to determine when a backup indexer has caught up.
 */
export async function handleSyncStatus(c: Context): Promise<Response> {
  try {
    const [progress, providerCountResult] = await Promise.all([
      getIndexerProgress(),
      db.select({ count: count() }).from(provider),
    ]);

    const hasData = Number(providerCountResult[0].count) > 0;
    const synced = progress.behindBlocks < SYNC_THRESHOLD_BLOCKS && hasData;

    const response: SyncStatusResponse = {
      synced,
      indexedBlock: progress.indexedBlock,
      chainHead: progress.chainHead,
      behindBlocks: progress.behindBlocks,
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
