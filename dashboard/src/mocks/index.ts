import type { NodeStatus, BlockInfo, BlockDetail, TxDetail, PeerInfo, MempoolTx } from "@/lib/api";

import statusFixture from "./fixtures/status.json";
import blocksFixture from "./fixtures/blocks.json";
import txsFixture from "./fixtures/txs.json";
import peersFixture from "./fixtures/peers.json";
import mempoolFixture from "./fixtures/mempool.json";

// ---------------------------------------------------------------------------
// Typed exports
// ---------------------------------------------------------------------------
export const mockStatus: NodeStatus = statusFixture as NodeStatus;
export const mockBlocks: BlockDetail[] = blocksFixture as unknown as BlockDetail[];
export const mockTxs: TxDetail[] = txsFixture as unknown as TxDetail[];
export const mockPeers: PeerInfo[] = peersFixture as unknown as PeerInfo[];
export const mockMempool: MempoolTx[] = mempoolFixture as unknown as MempoolTx[];

// ---------------------------------------------------------------------------
// Helper look-ups
// ---------------------------------------------------------------------------

/** Find a mock block by its hash. */
export function getMockBlockByHash(hash: string): BlockDetail | undefined {
  return mockBlocks.find((b) => b.hash === hash);
}

/** Find a mock transaction by its hash. */
export function getMockTxByHash(hash: string): TxDetail | undefined {
  return mockTxs.find((t) => t.hash === hash);
}

/**
 * Generate `count` synthetic blocks based on the first fixture entry.
 * Useful for stress-testing the block list without a live node.
 */
export function generateMockBlocks(count: number): BlockInfo[] {
  const base = mockBlocks[0];
  if (!base) return [];

  return Array.from({ length: count }, (_, i) => ({
    slot: base.slot - i * 20,
    hash: `gen_${i.toString(16).padStart(60, "0")}`,
    prevHash: i === 0 ? base.prevHash : `gen_${(i - 1).toString(16).padStart(60, "0")}`,
    era: base.era,
    epoch: base.epoch,
    txCount: Math.floor(Math.random() * 30),
    size: 4096 + Math.floor(Math.random() * 80000),
    insertedAt: new Date(Date.now() - i * 20_000).toISOString(),
  }));
}
