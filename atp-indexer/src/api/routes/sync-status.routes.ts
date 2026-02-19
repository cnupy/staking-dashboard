import { Hono } from 'hono';
import { handleSyncStatus } from '../handlers/sync-status';
import { healthCheckLimiter } from '../middleware/rate-limit';

export const syncStatusRoutes = new Hono();

/**
 * GET /api/sync-status
 * Returns indexer sync status for blue-green deployment automation
 */
syncStatusRoutes.get('/', healthCheckLimiter, handleSyncStatus);
