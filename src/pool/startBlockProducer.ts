/** Wire the BlockProducer to the running node (orchestrator, DB, shared mempool). */
import { getHardForkHistory } from "../consensus/hfc/hfcNode";
import { eraIndexAt } from "../consensus/hfc/eraOfTip";
import { getConsensus } from "../network/peerManager";
import { ledgerUtxoReads } from "../ledger/nodeLedgerStore";
import type { GerolamoConfig } from "../network/peerManager";
import { getInboundN2NStatus } from "../network/peerManager";
import { GlobalSharedMempool } from "../network/SharedMempool";
import { getMempool } from "../mempool";
import { hashBytes } from "../network/txSubmissionCodec";
import { getChainTip } from "../db";
import { sql } from "../sql";
import { readEpochParamsRaw } from "../consensus/epochParams";
import { epochForSlot, getEpochNetwork } from "../utils/epochFromSlotCalculations";
import { bech32Decode, buildWithMinFee, KeyEnvelopeType, loadSigningKey, messageMetadata, txId, type KeyPair } from "./operator";
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
    // The network the node set at startup (from NETWORK / --network); `config.network` is not
    // always populated, and its default is preprod — the producer then computed KES period 1015
    // on preview (period 944) and refused a valid certificate (2026-09-10 06:11 UTC).
    const network = getEpochNetwork();
    logger.info(`Block producer: network ${network}, genesis ${config.shelleyGenesisFile}`);
    const tip = await getChainTip();
    // era of the tip: Conway from the network's Conway epoch; the header layout is the same for Babbage/Conway
    const hfc = getHardForkHistory(); // ledger-driven era history; ledger era numbering = HFC index + 1
    const conwayEpoch = network === "preview" ? 646 : network === "preprod" ? 163 : 507;
    const tableEra = tip && Number(tip.slot) >= 0 && epochOf(network, tip.slot) >= conwayEpoch ? 7 : 6;
    // Bug 237 (2026-09-30 03:32 UTC): the history was "ready" with only the config eras (Byron..Alonzo) on a
    // Mithril-bootstrapped node and the forged block got era tag 5; the known history is the floor.
    const era = tip ? eraIndexAt(hfc, BigInt(tip.slot), tableEra - 1) + 1 : tableEra; // ledger era = HFC index + 1
    const node = nodeAdapter({
        network, era, genesis,
        nonceFor: (e) => consensus.epochNonceFor(e),
        adopt: (b) => consensus.adoptLocalBlock(b),
        mempoolTxs: async () => {
            const mp = GlobalSharedMempool.getInstance();
            const hs = await mp.getTxHashesAndSizes();
            const txs = await mp.getTxs(hs.map((h) => h.hash as any));
            return txs.map((t) => ({ hash: hashBytes(t.hash), bytes: t.bytes }));
        },
        mempoolSnapshot: getMempool() ? (slot) => getMempool()!.snapshotForBlock(slot) : undefined,
        dropFromMempool: async (hashes) => { const vm = getMempool(); if (vm) await vm.remove(hashes); else await GlobalSharedMempool.getInstance().drop(hashes as any); },
        greetingTx: pc.greeting ? greetingBuilder(pc.greeting, network) : undefined,
    });
    node.carriers = () => {
        const inb = getInboundN2NStatus();
        const inbound = (inb.clientList ?? []).filter((c) => c.chainSyncSlot != null).map((c) => c.peer);
        return { inbound, duplex: inb.duplexPullers ?? [], publicReachable: inb.publicReachable ? inb.publicReachable.ok : null };
    };
    producer = new BlockProducer(pc, node);
    await producer.start();
    logger.info(`Block producer started for pool ${producer.poolId}`);
    return producer;
}

function epochOf(network: ReturnType<typeof normalizeEpochNetwork>, slot: bigint): number {
    const { epochForSlot } = require("../utils/epochFromSlotCalculations") as typeof import("../utils/epochFromSlotCalculations");
    return Number(epochForSlot(slot, network));
}

/**
 * Temporary (first block per network): a payment from the greeting wallet back to itself that
 * carries the metadata message "Gerolamo was here!" (label 674). Built at forge time from the
 * wallet's largest ada-only UTxO and the epoch's fee parameters; TTL two hours.
 */
function greetingBuilder(g: { paymentSkeyFile: string; paymentAddress: string }, network: ReturnType<typeof normalizeEpochNetwork>): () => Promise<{ hash: Uint8Array; bytes: Uint8Array } | null> {
    let key: KeyPair | null = null;
    return async () => {
        key ??= loadSigningKey(g.paymentSkeyFile, KeyEnvelopeType.paymentSigning);
        const address = bech32Decode(g.paymentAddress).bytes;
        const ur = ledgerUtxoReads();
        const rows: unknown[][] = ur
            ? ur.byAddress(g.paymentAddress).map((u) => [u.utxo_ref, u.lovelace, u.tx_out])
            : (await sql`SELECT utxo_ref, lovelace, tx_out FROM utxo WHERE address = ${g.paymentAddress}`.values()) as unknown[][];
        const usable = rows
            .map((r) => ({ ref: String(r[0]), lovelace: BigInt(String(r[1] ?? 0)), txOut: String(r[2] ?? "{}") }))
            .filter((u) => { try { const assets = JSON.parse(u.txOut)?.assets ?? {}; return Object.keys(assets).every((k) => k === "") && u.lovelace >= 2_000_000n; } catch { return false; } })
            .sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1));
        const u = usable[0];
        if (!u) { logger.warn(`Block producer: greeting wallet ${g.paymentAddress.slice(0, 20)}… has no ada-only UTxO of 2 ADA or more`); return null; }
        const tip = await getChainTip();
        if (!tip) return null;
        const raw = (await readEpochParamsRaw(Number(epochForSlot(tip.slot, network)))) ?? {};
        const [txHash, index] = u.ref.split(":");
        const built = buildWithMinFee({
            inputs: [{ txHash: Uint8Array.from(Buffer.from(txHash!, "hex")), index: Number(index) }],
            outputs: [{ address, lovelace: u.lovelace }], changeIndex: 0,
            ttl: tip.slot + 7200n, certificates: [],
            auxiliaryData: messageMetadata(["Gerolamo was here!"]),
            minFeeA: BigInt(String(raw.min_fee_a ?? 44)), minFeeB: BigInt(String(raw.min_fee_b ?? 155381)), keys: [key],
        });
        return { hash: txId(built.body), bytes: built.tx };
    };
}
