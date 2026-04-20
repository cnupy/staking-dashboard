import { Hono } from 'hono';
import { handleRollupList } from '../handlers/rollup/list';
import { pollingLimiter } from '../middleware/rate-limit';

export const rollupRoutes = new Hono();

/**
 * GET /api/rollups
 * List the current canonical rollup + every historical rollup the Registry
 * has ever made canonical.
 */
rollupRoutes.get('/', pollingLimiter, handleRollupList);
