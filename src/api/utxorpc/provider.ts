/**
 * What the UTxO RPC services read from the node (the seam the tests drive): block store, ledger
 * store UTxOs (current, and as of a volatile block), protocol parameters, genesis, era history,
 * the mempool, transaction submission and Plutus evaluation. `nodeProvider` wires them to the
 * running node's singletons.
 */
import { join } from "node:path";
import type { BlockStore } from "../../storage/blockStore";
import { getNodeBlockStore } from "../../storage/nodeBlockStore";
import { UtxoReads } from "../../ledger/utxoStore";
import { getLedgerStore, ledgerGovReads, ledgerUtxoReads } from "../../ledger/nodeLedgerStore";
import { getStoredEpochParams, type EpochBodyParams, epochParamsFromRecord } from "../../consensus/epochParams";
import { epochForSlot, slotToUnixTime } from "../../utils/epochFromSlotCalculations";
import { eraSummaryFor, networkFromMagic, systemStartFor } from "../../network/n2c/eraHistory";
import type { EraSummary } from "../../consensus/hfc/hfc";
import { eraGenesisFilesFor } from "../../consensus/pparams";
import { getMempool } from "../../mempool";
import { GlobalSharedMempool } from "../../network/SharedMempool";
import { subscribeChainChanged } from "../../network/liveEvents";
import { mempoolTxHashToString } from "@harmoniclabs/shared-cardano-mempool-ts";
import { resolvedFromRow, type ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import type { GenesisFiles } from "./params";

export interface MempoolSnapshotLike { version: number; txs: Array<{ txId: string; bytes: Uint8Array }> }
export interface MempoolSource {
    snapshot(): Promise<MempoolSnapshotLike>;
    /** Resolves once the snapshot changed from `version` (or the signal aborted). */
    waitForChange(version: number, signal: AbortSignal): Promise<void>;
}

export interface SubmitVerdict { accepted: boolean; reason?: string }

export interface UtxorpcProvider {
    blockStore(): BlockStore | null;
    /** The ledger's UTxO set at the selected tip (LMDB ledger store), null when unavailable. */
    utxos(): UtxoReads | null;
    /** The UTxO set after a volatile block (or the anchor), null when the ledger store does not hold it. */
    utxosAfter(blockHash: Uint8Array): UtxoReads | null;
    /** Stored protocol-parameter record (Blockfrost field names) in force in `epoch`. */
    pparams(epoch: number): Promise<Record<string, unknown> | null>;
    epochOfSlot(slot: bigint): number;
    slotToUnixMs(slot: bigint): bigint;
    networkMagic(): number;
    genesisFiles(): GenesisFiles;
    /** Hard-fork history up to the era of the tip (HFC index: Byron 0 … Conway 6). */
    eraSummary(eraIndex: number, tipSlot: bigint): EraSummary[] | null;
    systemStartMs(): bigint | null;
    submitTx(tx: Uint8Array): Promise<SubmitVerdict>;
    mempool(): MempoolSource | null;
    onChainChange(cb: () => void): () => void;
    /** Protocol parameters and resolved inputs for evaluating a transaction at the tip, null when unavailable. */
    evalContext(refs: string[]): Promise<{ params: EpochBodyParams; resolved: Map<string, ResolvedUtxo>; network: string } | null>;
    /** Where a transaction was included (explorer projection), when known. */
    txLocation(txIdHex: string): Promise<{ blockHash: Uint8Array } | null>;
    /** A datum's CBOR by hash (explorer projection of inline datums), when known. */
    datum(hashHex: string): Promise<Uint8Array | null>;
}

/** The mempool as a `MempoolSource`: the validating mempool when it runs, else the shared-memory store (polled). */
export function nodeMempoolSource(): MempoolSource | null {
    const vm = getMempool();
    if (vm) {
        return {
            async snapshot() { const s = await vm.snapshot(); return { version: s.version, txs: s.txs.map((t) => ({ txId: t.txId, bytes: t.bytes })) }; },
            waitForChange(version, signal) {
                if (signal.aborted) return Promise.resolve();
                const token = { cancelled: false };
                return new Promise<void>((resolve) => {
                    const onAbort = () => { token.cancelled = true; resolve(); };
                    signal.addEventListener("abort", onAbort, { once: true });
                    void vm.waitForChange(version, token).then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
                    // the waiter is woken by the next bump; a cancelled token lets it go then
                });
            },
        };
    }
    let lastKey = "", version = 0;
    const read = async (): Promise<MempoolSnapshotLike> => {
        const hashes = await GlobalSharedMempool.getTxHashes();
        const txs: Array<{ txId: string; bytes: Uint8Array }> = [];
        for (const h of hashes) {
            const id = mempoolTxHashToString(h);
            const bytes = await GlobalSharedMempool.getTx(Uint8Array.from(Buffer.from(id, "hex")));
            if (bytes) txs.push({ txId: id, bytes });
        }
        const key = txs.map((t) => t.txId).join(",");
        if (key !== lastKey) { lastKey = key; version++; }
        return { version, txs };
    };
    return {
        snapshot: read,
        async waitForChange(v, signal) {
            while (!signal.aborted) {
                await new Promise((r) => setTimeout(r, 500));
                if ((await read()).version !== v) return;
            }
        },
    };
}

export interface NodeProviderConfig {
    networkMagic: number;
    shelleyGenesisFile?: string;
    byronGenesisFile?: string;
    alonzoGenesisFile?: string;
    conwayGenesisFile?: string;
    network?: string;
}

/** The running node's state. `submit` hands a transaction to the node's mempool (the HTTP submit path). */
export function nodeProvider(config: NodeProviderConfig, submit: (tx: Uint8Array) => Promise<{ status: string }>): UtxorpcProvider {
    const net = networkFromMagic(config.networkMagic);
    const configDir = join(import.meta.dir, "..", "..", "config", net ?? "preview");
    const shelley = config.shelleyGenesisFile ?? (net ? join(configDir, "shelley-genesis.json") : undefined);
    const era = eraGenesisFilesFor({ ...config, shelleyGenesisFile: shelley });
    const files: GenesisFiles = {
        byron: config.byronGenesisFile ?? (net ? join(configDir, "byron-genesis.json") : null),
        shelley: shelley ?? null,
        alonzo: era.alonzo ?? null,
        conway: era.conway ?? null,
    };
    return {
        blockStore: () => getNodeBlockStore(),
        utxos: () => ledgerUtxoReads(),
        utxosAfter(hash) {
            const st = getLedgerStore();
            const v = st?.viewAt(hash);
            return v ? new UtxoReads(v) : null;
        },
        async pparams(epoch) {
            const g = ledgerGovReads();
            const fromStore = g?.epochParams(epoch)?.params ?? g?.epochParams(epoch - 1)?.params;
            if (fromStore) return fromStore as Record<string, unknown>;
            return (await getStoredEpochParams(epoch)) ?? (await getStoredEpochParams(epoch - 1));
        },
        epochOfSlot: (slot) => Number(epochForSlot(slot)),
        slotToUnixMs: (slot) => BigInt(slotToUnixTime(slot)) * 1000n,
        networkMagic: () => config.networkMagic,
        genesisFiles: () => files,
        eraSummary: (eraIndex, tipSlot) => eraSummaryFor(net, eraIndex, tipSlot),
        systemStartMs() { const s = systemStartFor(net); return s ? BigInt(Date.parse(s)) : null; },
        async submitTx(tx) {
            const r = await submit(tx);
            return r.status === "success" ? { accepted: true } : { accepted: false, reason: r.status };
        },
        mempool: () => nodeMempoolSource(),
        onChainChange: (cb) => subscribeChainChanged(cb),
        async evalContext(refs) {
            const reads = ledgerUtxoReads();
            const bs = getNodeBlockStore();
            if (!reads || !bs) return null;
            const { selectedTip } = await import("../../storage/blockReads");
            const tip = await selectedTip(bs);
            if (!tip) return null;
            const epoch = Number(epochForSlot(BigInt(tip.slot) + 1n));
            const raw = await this.pparams(epoch);
            if (!raw) return null;
            const resolved = new Map<string, ResolvedUtxo>();
            for (const r of reads.getMany(refs)) resolved.set(r.utxo_ref, resolvedFromRow(r));
            return { params: epochParamsFromRecord(epoch, raw), resolved, network: net ?? String(config.network ?? "") };
        },
        async txLocation(txIdHex) {
            try {
                const { getMbTxByHash } = await import("../../db/minibf/queries");
                const row = await getMbTxByHash(txIdHex);
                return row?.block_hash && /^[0-9a-f]{64}$/.test(row.block_hash) ? { blockHash: Uint8Array.from(Buffer.from(row.block_hash, "hex")) } : null;
            } catch { return null; }
        },
        async datum(hashHex) {
            try {
                const { mbSql } = await import("../../db/minibf/explorerIndexer");
                const rows = (await mbSql()`SELECT inline_datum_cbor FROM mb_tx_out WHERE datum_hash = ${hashHex} AND inline_datum_cbor IS NOT NULL LIMIT 1`.values()) as unknown[][];
                const v = rows[0]?.[0];
                if (v instanceof Uint8Array) return v;
                if (typeof v === "string" && /^[0-9a-f]+$/i.test(v)) return Uint8Array.from(Buffer.from(v, "hex"));
                return null;
            } catch { return null; }
        },
    };
}
