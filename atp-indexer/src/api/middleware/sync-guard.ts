import type { Context, Next } from 'hono';
import { db } from 'ponder:api';
import { max, count } from 'drizzle-orm';
import { deposit, provider, atpPosition } from 'ponder:schema';
import { getPublicClient } from '../../utils/viem-client';

/**
 * Sync guard middleware — returns 503 when the indexer is significantly behind
 * the chain head. This triggers CloudFront origin group failover to the
 * secondary (backup) indexer.
 *
 * Background check runs every 30s. Excluded paths (/api/sync-status, /api/health)
 * always pass through so the blue-green cron can still query sync status.
 */

const BEHIND_THRESHOLD = 200;
const CHECK_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;

const EXCLUDED_PREFIXES = ['/api/sync-status', '/api/health'];

class SyncGuard {
  private behindBlocks = 0;
  private hasData = false;
  private healthy = true;
  private initialized = false;

  constructor() {
    setTimeout(() => this.check(), INITIAL_DELAY_MS);
    setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  private async check() {
    try {
      const client = getPublicClient();

      const [chainHeadBlock, depositMax, providerMax, atpMax, providerCount] =
        await Promise.all([
          client.getBlockNumber(),
          db.select({ maxBlock: max(deposit.blockNumber) }).from(deposit),
          db.select({ maxBlock: max(provider.blockNumber) }).from(provider),
          db.select({ maxBlock: max(atpPosition.blockNumber) }).from(atpPosition),
          db.select({ count: count() }).from(provider),
        ]);

      const chainHead = Number(chainHeadBlock);
      const maxBlocks = [
        depositMax[0]?.maxBlock,
        providerMax[0]?.maxBlock,
        atpMax[0]?.maxBlock,
      ]
        .filter((b): b is bigint => b !== null && b !== undefined)
        .map(Number);

      const indexedBlock = maxBlocks.length > 0 ? Math.max(...maxBlocks) : 0;
      this.hasData = Number(providerCount[0].count) > 0;
      this.behindBlocks = chainHead - indexedBlock;
      this.healthy = this.behindBlocks < BEHIND_THRESHOLD && this.hasData;
      this.initialized = true;

      if (!this.healthy) {
        console.warn(
          `[sync-guard] Unhealthy: ${this.behindBlocks} blocks behind (threshold: ${BEHIND_THRESHOLD}, hasData: ${this.hasData})`
        );
      }
    } catch (error) {
      console.error('[sync-guard] Check failed:', error);
      // Keep previous state on transient failures
    }
  }

  middleware() {
    return async (c: Context, next: Next) => {
      const path = c.req.path;

      if (EXCLUDED_PREFIXES.some((p) => path.startsWith(p))) {
        await next();
        return;
      }

      // Return 503 once initialized and unhealthy.
      // Before initialization, pass through (assume healthy).
      if (this.initialized && !this.healthy) {
        c.header('Retry-After', '30');
        return c.json(
          {
            error: 'Service temporarily unavailable — indexer is syncing',
            behindBlocks: this.behindBlocks,
          },
          503
        );
      }

      await next();
    };
  }
}

export const syncGuard = new SyncGuard();
