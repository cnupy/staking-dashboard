import type { Context } from 'hono';
import { db } from 'ponder:api';
import { asc } from 'drizzle-orm';
import { rollupVersion } from 'ponder:schema';
import { checksumAddress } from '../../../utils/address';
import type { RollupListResponse } from '../../types/rollup.types';

/**
 * Handle GET /api/rollups
 * Returns the current canonical rollup plus every historical rollup the
 * Registry has ever made canonical. Lets the frontend (and other clients)
 * avoid making their own Registry RPC calls at boot, and gives the UI what
 * it needs for future cross-rollup flows (e.g. claiming unclaimed rewards
 * from a previous rollup).
 *
 * Source of truth: the rollup_version table, populated from
 * Registry.CanonicalRollupUpdated events.
 */
export async function handleRollupList(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select()
      .from(rollupVersion)
      .orderBy(asc(rollupVersion.blockNumber));

    const versions = rows.map(r => ({
      version: r.version.toString(),
      address: checksumAddress(r.address),
      blockNumber: Number(r.blockNumber),
      timestamp: Number(r.timestamp),
    }));

    const canonical = versions.length > 0
      ? versions[versions.length - 1].address
      : null;

    const response: RollupListResponse = { canonical, versions };
    return c.json(response);
  } catch (error) {
    console.error('Error fetching rollup versions:', error);
    return c.json({
      error: 'Failed to fetch rollup versions',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}
