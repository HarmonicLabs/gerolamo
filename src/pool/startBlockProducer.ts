/** Wire the BlockProducer to the running node (orchestrator, DB, shared mempool). */
import { getConsensus } from "../network/peerManager";
import type { GerolamoConfig } from "../network/peerManager";
import { GlobalSharedMempool } from "../network/SharedMempool";
import { getChainTip } from "../db";
import { normalizeEpochNetwork } from "../utils/epochFromSlotCalculations";
import { logger } from "../utils/logger";
import { BlockProducer, nodeAdapter } from "./BlockProducer";

let producer: BlockProducer | null = null;

export function getBlockProducer(): BlockProducer | null {
    return producer;
}

export async function startBlockProducer(config: GerolamoConfig): Promise<BlockProducer> {
    const consensus = getConsensus();
    if (!consensus) throw new Error("consensus orchestrator not initialised");
    const pc = config.producer!;
    const genesis = await Bun.file(config.shelleyGenesisFile).json() as { activeSlotsCoeff: number; slotsPerKESPeriod: number; maxKESEvolutions: number };
    const network = normalizeEpochNetwork(config.network);
    const tip = await getChainTip();
    // era of the tip: Conway from the network's Conway epoch; the header layout is the same for Babbage/Conway
    const conwayEpoch = network === "preview" ? 646 : network === "preprod" ? 163 : 507;
    const era = tip && Number(tip.slot) >= 0 && epochOf(network, tip.slot) >= conwayEpoch ? 7 : 6;
    const node = nodeAdapter({
        network, era, genesis,
        nonceFor: (e) => consensus.epochNonceFor(e),
        adopt: (b) => consensus.adoptLocalBlock(b),
        mempoolTxs: async () => {
            const mp = GlobalSharedMempool.getInstance();
            const hs = await mp.getTxHashesAndSizes();
            const txs = await mp.getTxs(hs.map((h) => h.hash as any));
            return txs.map((t) => ({ hash: t.hash as unknown as Uint8Array, bytes: t.bytes }));
        },
        dropFromMempool: async (hashes) => { await GlobalSharedMempool.getInstance().drop(hashes as any); },
    });
    producer = new BlockProducer(pc, node);
    await producer.start();
    logger.info(`Block producer started for pool ${producer.poolId}`);
    return producer;
}

function epochOf(network: ReturnType<typeof normalizeEpochNetwork>, slot: bigint): number {
    const { epochForSlot } = require("../utils/epochFromSlotCalculations") as typeof import("../utils/epochFromSlotCalculations");
    return Number(epochForSlot(slot, network));
}
