/**
 * Rollup API Response Types
 */

export interface RollupVersionRow {
  version: string;         // Registry version id (uint256, stringified)
  address: string;         // Checksummed rollup address
  blockNumber: number;     // Block at which this rollup became canonical
  timestamp: number;       // Block timestamp (unix seconds)
}

export interface RollupListResponse {
  canonical: string | null;         // Latest canonical rollup address (null before first event is indexed)
  versions: RollupVersionRow[];     // Every rollup ever made canonical, oldest first
}
