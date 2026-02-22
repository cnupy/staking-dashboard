import { sql } from 'drizzle-orm';
import { db } from 'ponder:api';
import { getPublicClient } from '../../utils/viem-client';

/**
 * Block number is encoded at positions 26–41 (16 digits) in Ponder's
 * 75-character checkpoint string.
 */
const BLOCK_NUMBER_OFFSET = 26;
const BLOCK_NUMBER_LENGTH = 16;

function decodeBlockNumber(checkpoint: string): number {
  return Number(checkpoint.slice(BLOCK_NUMBER_OFFSET, BLOCK_NUMBER_OFFSET + BLOCK_NUMBER_LENGTH));
}

/**
 * Get the indexer's actual processing progress by reading Ponder's
 * internal `_ponder_checkpoint` table.
 *
 * This is more accurate than MAX(block_number) on event tables, which only
 * reflects the block of the last *emitted event*, not the last *processed block*.
 */
export async function getIndexerProgress(): Promise<{
  indexedBlock: number;
  chainHead: number;
  behindBlocks: number;
}> {
  const client = getPublicClient();

  const [chainHeadBlock, checkpointRows] = await Promise.all([
    client.getBlockNumber(),
    db.execute(sql`SELECT "latest_checkpoint" FROM "_ponder_checkpoint" LIMIT 1`),
  ]);

  const chainHead = Number(chainHeadBlock);

  // drizzle execute() returns { rows: [...] } for node-postgres
  const rows = (checkpointRows as unknown as { rows: { latest_checkpoint: string }[] }).rows;
  const latestCheckpoint = rows?.[0]?.latest_checkpoint;

  const indexedBlock = latestCheckpoint ? decodeBlockNumber(latestCheckpoint) : 0;
  const behindBlocks = chainHead - indexedBlock;

  return { indexedBlock, chainHead, behindBlocks };
}
