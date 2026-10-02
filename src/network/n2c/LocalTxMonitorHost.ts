import { Cbor, CborArray, CborMap, CborSimple, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { MiniProtocol, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { GlobalSharedMempool, MempoolSize } from "../SharedMempool";
import { hashBytes } from "../txSubmissionCodec";
import { getMaxSlot } from "../../db";
import { logger } from "../../utils/logger";
import { getMempool } from "../../mempool";
import { CONWAY_ERA_INDEX } from "../../mempool/applyTxErr";
import { unwrapHfcTxId, wrapHfcTx } from "../../mempool/mempoolTx";
import type { MempoolMeasures, MempoolSnapshot } from "../../mempool/ValidatingMempool";

const log = logger.child("n2c.localtxmonitor");
const PROTO = MiniProtocol.LocalTxMonitor;

/** Node-to-client version from which MsgGetMeasures exists (ouroboros-network LocalTxMonitor_V2). */
export const GET_MEASURES_MIN_VERSION = 20;

const U = (n: number | bigint) => new CborUInt(typeof n === "bigint" ? n : BigInt(n));
const enc = (o: CborObj) => Cbor.encode(o).toBuffer();

/** MsgReplyGetMeasures `[12, txCount, {name: [size, capacity]}]`, names in `Map MeasureName` (text) order. */
export function replyGetMeasuresBytes(m: MempoolMeasures): Uint8Array {
    const entries: Array<[string, bigint, bigint]> = [
        ["ex_units_memory", m.exUnitsMemory.size, m.exUnitsMemory.capacity],
        ["ex_units_steps", m.exUnitsSteps.size, m.exUnitsSteps.capacity],
        ["reference_scripts_bytes", BigInt(m.referenceScriptsBytes.size), BigInt(m.referenceScriptsBytes.capacity)],
        ["transaction_bytes", BigInt(m.bytes.size), BigInt(m.bytes.capacity)],
    ];
    return enc(new CborArray([U(12), U(m.txCount), new CborMap(entries.map(([k, s, c]) => ({ k: new CborText(k), v: new CborArray([U(s), U(c)]) })))]));
}

/** MsgReplyGetSizes `[10, [capacityInBytes, sizeInBytes, numberOfTxs]]`. */
export function replyGetSizesBytes(m: MempoolMeasures): Uint8Array {
    return enc(new CborArray([U(10), new CborArray([U(m.bytes.capacity), U(m.bytes.size), U(m.txCount)])]));
}

/**
 * N2C LocalTxMonitor server (protocol 9), ouroboros-network codec:
 *   Idle:     [0] Done · [1] Acquire → [2, slot]
 *   Acquired: [1] AwaitAcquire (answers once the snapshot changes) · [3] Release · [5] NextTx → [6] | [6, [era, #6.24(tx)]]
 *             [7, [era, txid]] HasTx → [8, bool] · [9] GetSizes → [10, [cap, size, n]] · [11] GetMeasures → [12, n, {…}] (v20+)
 * The snapshot is the validating mempool's: its slot is the tip + 1 (the slot the transactions
 * were validated for), its ids are body hashes.
 */
export class LocalTxMonitorHost {
    readonly mplexer: Multiplexer;
    private acquired = false;
    private snapshot: MempoolSnapshot | null = null;
    private nextIdx = 0;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;
    private queue: Promise<void> = Promise.resolve();
    private awaiting: { cancelled: boolean } | null = null;

    constructor(mplexer: Multiplexer, private readonly n2cVersion = 23) {
        this.mplexer = mplexer;
        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
        GlobalSharedMempool.getInstance();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.acquired = false;
        this.snapshot = null;
        if (this.awaiting) this.awaiting.cancelled = true;
        try {
            this.mplexer.off(PROTO, this.listener);
        } catch {
            /* ignore */
        }
    }

    private sendBytes(bytes: Uint8Array): void {
        if (this.disposed) return;
        this.mplexer.send(bytes, {
            hasAgency: false, // responder direction (the 0x8000 bit on the wire): a client rejects replies on its own initiator side (cardano-cli, 2026-09-14)
            protocol: PROTO,
        });
    }

    private onChunk(chunk: Uint8Array): void {
        if (this.disposed) return;
        let data = chunk;
        if (this.prevBytes) {
            const tmp = new Uint8Array(this.prevBytes.length + chunk.length);
            tmp.set(this.prevBytes, 0);
            tmp.set(chunk, this.prevBytes.length);
            data = tmp;
            this.prevBytes = undefined;
        }
        while (data.length > 0) {
            let parsed: CborObj;
            let offset: number;
            try {
                const thing = Cbor.parseWithOffset(data);
                parsed = thing.parsed;
                offset = thing.offset;
            } catch {
                this.prevBytes = Uint8Array.prototype.slice.call(data);
                return;
            }
            this.queue = this.queue.then(() => this.handle(parsed)).catch((err) => log.error("LocalTxMonitor handler failed:", err));
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: CborObj): Promise<void> {
        if (!(msg instanceof CborArray) || !(msg.array[0] instanceof CborUInt)) { log.warn("LocalTxMonitor: malformed message"); return; }
        const tag = Number((msg.array[0] as CborUInt).num);
        if (!this.acquired) {
            if (tag === 0) { this.dispose(); return; }
            // [3] in Idle: ouroboros-miniprotocols-ts's TxMonitorAcquire encodes Acquire as [3]; treat it as Acquire.
            if (tag === 1 || tag === 3) { await this.acquire(); return; }
            log.warn(`LocalTxMonitor: message ${tag} while idle`);
            return;
        }
        switch (tag) {
            case 1: { // MsgAwaitAcquire: answer once the snapshot differs
                const mp = getMempool();
                if (mp && this.snapshot) {
                    this.awaiting = { cancelled: false };
                    await mp.waitForChange(this.snapshot.version, this.awaiting);
                    if (this.awaiting.cancelled) return;
                    this.awaiting = null;
                }
                await this.acquire();
                return;
            }
            case 3: this.acquired = false; this.snapshot = null; this.nextIdx = 0; return;
            case 5: {
                const txs = this.snapshot?.txs ?? [];
                if (this.nextIdx >= txs.length) { this.sendBytes(enc(new CborArray([U(6)]))); return; }
                const t = txs[this.nextIdx++]!;
                this.sendBytes(enc(new CborArray([U(6), wrapHfcTx(CONWAY_ERA_INDEX, t.bytes)])));
                return;
            }
            case 7: {
                const id = msg.array[1] ? unwrapHfcTxId(msg.array[1]) : null;
                const want = id ? toHex(id) : "";
                const has = !!want && (this.snapshot?.txs ?? []).some((t) => t.txId === want);
                this.sendBytes(enc(new CborArray([U(8), new CborSimple(has)])));
                return;
            }
            case 9: this.sendBytes(replyGetSizesBytes(this.snapshot!.measures)); return;
            case 11:
                if (this.n2cVersion < GET_MEASURES_MIN_VERSION) { log.warn(`LocalTxMonitor: MsgGetMeasures on node-to-client v${this.n2cVersion} (needs v${GET_MEASURES_MIN_VERSION}+)`); return; }
                this.sendBytes(replyGetMeasuresBytes(this.snapshot!.measures));
                return;
            default:
                log.warn(`LocalTxMonitor: unexpected message ${tag} while acquired`);
        }
    }

    private async acquire(): Promise<void> {
        this.snapshot = await takeSnapshot();
        this.nextIdx = 0;
        this.acquired = true;
        this.sendBytes(enc(new CborArray([U(2), U(this.snapshot.slot < 0n ? 0n : this.snapshot.slot)])));
        log.debug(`TxMonitor acquired snapshot nTxs=${this.snapshot.txs.length} slot=${this.snapshot.slot}`);
    }
}

/** The validating mempool's snapshot, or one built from the shared-memory store when there is none. */
async function takeSnapshot(): Promise<MempoolSnapshot> {
    const mp = getMempool();
    if (mp) return mp.snapshot();
    const store = GlobalSharedMempool.getInstance();
    const hs = await store.getTxHashesAndSizes();
    const txs = hs.length ? await store.getTxs(hs.map((h) => h.hash as any)) : [];
    let slot = 0n;
    try { slot = (await getMaxSlot()) + 1n; } catch { /* no chain */ }
    const list = txs.map((t, i) => { const id = hashBytes(t.hash); return { txId: toHex(id), txIdBytes: id, bytes: t.bytes, measureBytes: t.bytes.length + 3, ticket: i + 1 }; });
    const bytes = list.reduce((a, t) => a + t.measureBytes, 0);
    return {
        slot, txs: list, version: 0,
        measures: {
            txCount: list.length, bytes: { size: bytes, capacity: MempoolSize.kb256 },
            exUnitsMemory: { size: 0n, capacity: 0n }, exUnitsSteps: { size: 0n, capacity: 0n }, referenceScriptsBytes: { size: 0, capacity: 0 },
        },
    };
}

