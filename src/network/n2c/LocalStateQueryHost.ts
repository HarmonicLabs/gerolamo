import {
    Cbor,
    CborArray,
    CborMap,
    CborText,
    CborUInt,
    type CborObj,
} from "@harmoniclabs/cbor";
import {
    MiniProtocol,
    Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
// Not re-exported at package root.
import type { IChainDb } from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/interfaces/IChainDb.js";
import { getChainTipFromHeader } from "../../db";
import { ledgerStakeReads, ledgerUtxoReads } from "../../ledger/nodeLedgerStore";
import { sql } from "../../sql";
import { CborBytes, CborTag } from "@harmoniclabs/cbor";
import { debugLedgerConfig } from "./lsq/ledgerConfig";
import { HFC_ERA_NAMES, encodeUtcTime, interpreterFor, networkFromMagic, systemStartFor, type EraHistoryNetwork } from "./eraHistory";
import { calculatePreProdCardanoEpoch } from "../../utils/epochFromSlotCalculations";
import { readEpochParamsRaw } from "../../consensus/epochParams";
import { conwayPParamsCbor } from "./pparamsCbor";
import { addressString, txInRef, utxoMapCbor, type UtxoRowLike } from "./utxoCbor";
import { logger } from "../../utils/logger";
import { acquireView, viewCurrent, type LsqTarget, type LsqView } from "./lsq/view";
import { LsqUnanswerable, LsqUndecodable, answerConwayQuery, setItems } from "./lsq/queries";

const log = logger.child("n2c.localstatequery");
const PROTO = MiniProtocol.LocalStateQuery;
/** Payload bytes per mux segment (the header's length field is 16 bits; cardano-node's SDU is 12 288). */
const SDU = 12_288;
/** Conway-only queries: cardano-node's decoder fails them for an earlier era (`requireCG`), which ends the connection. */
const CONWAY_ONLY = new Set([23, 25, 26, 27, 28, 30, 31, 32, 33, 35, 39]);

/**
 * N2C LocalStateQuery server (protocol 7).
 *
 * Acquire: the volatile tip [8] / [9], the immutable tip [10] / [11] or a point [0, p] / [6, p] of
 * the selected chain within the last k blocks (lsq/view.ts); anything older is
 * AcquireFailurePointTooOld, anything off the chain AcquireFailurePointNotOnChain. Every answer
 * reads the acquired state. A query cardano-node cannot decode (unknown tag, wrong arity, a
 * Conway-only query for an earlier era) ends the connection, as a cardano-node's codec failure
 * does; so does one this node has no data for, rather than an answer the client cannot decode.
 */
export class LocalStateQueryHost {
    readonly mplexer: Multiplexer;
    readonly chainDb: IChainDb;
    private view: LsqView | null = null;
    private target: LsqTarget | null = null;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;
    /** Messages are handled one at a time, in order (an answer can take seconds; the next message waits). */
    private queue: Promise<void> = Promise.resolve();

    private readonly network: EraHistoryNetwork | null;
    private readonly magic: number;

    /** Negotiated node-to-client version (DebugLedgerConfig needs QueryVersion3, NodeToClientV_20 on); unknown: allowed. */
    private readonly n2cVersion: number | null;
    constructor(mplexer: Multiplexer, chainDb: IChainDb, networkMagic?: number, n2cVersion?: number) {
        this.n2cVersion = n2cVersion ?? null;
        this.mplexer = mplexer;
        this.chainDb = chainDb;
        this.network = networkMagic == null ? null : networkFromMagic(networkMagic);
        this.magic = networkMagic ?? 0;
        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.view = null;
        try {
            this.mplexer.off(PROTO, this.listener);
        } catch {
            /* ignore */
        }
    }

    /** Protocol error: drop the connection (what a cardano-node does when its codec or state machine fails). */
    private abort(reason: string): void {
        log.warn(`LocalStateQuery: closing the connection: ${reason}`);
        this.dispose();
        try { this.mplexer.close({ closeSocket: true }); } catch { /* gone */ }
    }

    /** Send one message's bytes, split into mux segments. */
    private sendBytes(bytes: Uint8Array): void {
        const header = {
            hasAgency: false, // responder direction (the 0x8000 bit on the wire): a client rejects replies on its own initiator side (cardano-cli, 2026-09-14)
            protocol: PROTO,
        };
        for (let o = 0; o < bytes.length; o += SDU) this.mplexer.send(bytes.subarray(o, Math.min(bytes.length, o + SDU)), header);
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
            this.queue = this.queue.then(() => this.handle(parsed)).catch((err) => this.abort(`handler failed: ${(err as Error).message}`));
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: CborObj): Promise<void> {
        if (this.disposed) return;
        const a = msg instanceof CborArray ? msg.array : null;
        const tag = a && a[0] instanceof CborUInt ? Number(a[0].num) : -1;
        switch (tag) {
            case 0: case 6: { const t = pointTarget(a![1]); if (!t) return this.abort("MsgAcquire: bad point"); return this.handleAcquire(t); }
            case 8: case 9: return this.handleAcquire({ kind: "volatile" });
            case 10: case 11: return this.handleAcquire({ kind: "immutable" });
            case 3: {
                if (!this.view) return this.abort("MsgQuery while not acquired");
                return this.handleQuery(a![1]!);
            }
            case 5: this.view = null; this.target = null; return;
            case 7: this.dispose(); return;
            default: return this.abort(`unknown LocalStateQuery message ${tag}`);
        }
    }

    private async handleAcquire(target: LsqTarget): Promise<void> {
        const r = await acquireView(target);
        if ("failure" in r) {
            this.view = null; this.target = null;
            this.sendBytes(Uint8Array.of(0x82, 0x02, r.failure)); // MsgFailure [2, 0 PointTooOld | 1 PointNotOnChain]
            log.info(`LSQ acquire ${target.kind}${target.kind === "point" ? ` ${target.slot}` : ""} failed: ${r.failure === 0 ? "PointTooOld" : "PointNotOnChain"}`);
            return;
        }
        this.view = r.view;
        // later rebuilds (after a promotion) re-acquire the block that was acquired, not a newer tip
        this.target = r.view.point ? { kind: "point", slot: r.view.point.slot, hash: r.view.point.hash } : target;
        this.sendBytes(Uint8Array.of(0x81, 0x01)); // MsgAcquired
        log.info(`LSQ acquired ${target.kind} at slot ${r.view.point?.slot ?? "origin"} (block ${r.view.point?.blockNo ?? "-"})`);
    }

    private async handleQuery(q: CborObj): Promise<void> {
        // the store promoted diffs into LMDB since the acquire: rebuild the same block's view
        if (this.view && !viewCurrent(this.view) && this.target) {
            const r = await acquireView(this.target);
            if ("view" in r) this.view = r.view;
            else log.warn(`LSQ: the acquired block left the volatile window; answering from the view taken at acquire`);
        }
        let result: Uint8Array;
        try {
            const r = await this.answer(q);
            result = r instanceof Uint8Array ? r : Cbor.encode(r).toBuffer();
        } catch (err) {
            if (err instanceof LsqUndecodable || err instanceof LsqUnanswerable) return this.abort(`${err instanceof LsqUndecodable ? "undecodable" : "unanswerable"} query ${describe(q)}: ${err.message}`);
            return this.abort(`query ${describe(q)} failed: ${(err as Error).stack ?? err}`);
        }
        const msg = new Uint8Array(result.length + 2);
        msg[0] = 0x82; msg[1] = 0x04; // MsgResult [4, result]
        msg.set(result, 2);
        this.sendBytes(msg);
    }

    /**
     * The queries cardano-cli and wallets send, encoded as ouroboros-consensus does (captured
     * from a cardano-node with scripts/n2c-oracle.ts). Query = [0, BlockQuery] · [1] GetSystemStart ·
     * [2] GetChainBlockNo · [3] GetChainPoint (both of the acquired state) · [4] DebugLedgerConfig. BlockQuery (HFC) =
     * [0, [era, q]] QueryIfCurrent (Right r = [r]; wrong era = [[qEra, name], [curEra, name]]) ·
     * [1, [0], era] QueryAnytime GetEraStart · [2, [0]] GetInterpreter · [2, [1]] GetCurrentEra.
     * The era's own queries are answered by lsq/queries.ts.
     */
    private async answer(q: CborObj): Promise<CborObj | Uint8Array> {
        const tag = (o: CborObj | undefined) => (o instanceof CborUInt ? Number(o.num) : -1);
        const arr = (o: CborObj | undefined) => (o instanceof CborArray ? o.array : null);
        const top = arr(q);
        if (!top) throw new LsqUndecodable("Query: not a list");
        const p = this.view?.point;
        const tip = p ? { slot: p.slot, blockNumber: p.blockNo, hashHex: p.hash, era: p.era + 1 } : await getChainTipFromHeader();
        const net = this.network;
        switch (tag(top[0])) {
            case 1: { const ss = systemStartFor(net); return ss ? encodeUtcTime(ss) : new CborArray([]); }
            case 2: return tip ? new CborArray([new CborUInt(1), new CborUInt(tip.blockNumber)]) : new CborArray([new CborUInt(0)]);
            case 3: return tip ? new CborArray([new CborUInt(tip.slot), new CborBytes(Uint8Array.from(Buffer.from(tip.hashHex, "hex")))]) : new CborArray([]);
            case 4: { // DebugLedgerConfig (lsq/ledgerConfig.ts)
                if (this.n2cVersion != null && this.n2cVersion < 20) throw new LsqUndecodable("DebugLedgerConfig needs QueryVersion3 (node-to-client v20)");
                return debugLedgerConfig(net, this.magic);
            }
            case 0: {
                const bq = arr(top[1]);
                if (!bq) break;
                const eraIndex = tip ? Math.max(0, tip.era - 1) : 0; // our era numbering counts the Byron EBB era; the HFC index does not
                if (tag(bq[0]) === 2) {
                    const hq = arr(bq[1]);
                    if (hq && tag(hq[0]) === 1) return new CborUInt(eraIndex);
                    if (hq && tag(hq[0]) === 0) { const i = interpreterFor(net, eraIndex, tip ? BigInt(tip.slot) : null); if (i) return i; } // ledger-driven HFC history (consensus/hfc)
                    break;
                }
                if (tag(bq[0]) === 1) {
                    // QueryAnytime GetEraStart: Maybe Bound — the era's start ([] for an era not reached yet)
                    const aq = arr(bq[1]);
                    if (!aq || tag(aq[0]) !== 0 || !net) break;
                    const era = tag(bq[2]);
                    if (era > eraIndex) return new CborArray([]);
                    const summary = interpreterFor(net, eraIndex, tip ? BigInt(tip.slot) : null) as CborArray | null; // ledger-driven HFC history
                    const s = summary?.array[era];
                    return s instanceof CborArray ? new CborArray([s.array[0]!]) : new CborArray([]);
                }
                if (tag(bq[0]) === 0) {
                    const ic = arr(bq[1]);
                    if (!ic) break;
                    const qEra = tag(ic[0]);
                    const sq = arr(ic[1]);
                    if (!sq) break;
                    if (tag(sq[0]) < 0 || tag(sq[0]) > 39) throw new LsqUndecodable(`decodeShelleyQuery: invalid tag ${tag(sq[0])}`);
                    if (qEra < 6 && CONWAY_ONLY.has(tag(sq[0]))) throw new LsqUndecodable(`query ${tag(sq[0])} is not supported before Conway`);
                    if (qEra !== eraIndex) {
                        const name = (i: number) => new CborText(HFC_ERA_NAMES[i] ?? `era${i}`);
                        return new CborArray([new CborArray([new CborUInt(qEra), name(qEra)]), new CborArray([new CborUInt(eraIndex), name(eraIndex)])]);
                    }
                    if (!this.view?.stake) return new CborArray([await this.answerWithoutLedgerStore(sq, tip)]);
                    const r = await answerConwayQuery(this.view, { network: net, magic: this.magic }, sq);
                    const out = new Uint8Array(r.length + 1); out[0] = 0x81; out.set(r, 1); // Right r = [r]
                    return out;
                }
                break;
            }
            default: break;
        }
        throw new LsqUndecodable(`unsupported query ${describe(q)}`);
    }

    /**
     * sqlite mode (no LMDB ledger store): the tip queries the node answered before the store
     * existed, from the live SQLite tables (the view is always the tip there).
     */
    private async answerWithoutLedgerStore(sq: CborObj[], tip: { slot: bigint; hashHex: string } | null): Promise<CborObj> {
        const tag = (o: CborObj | undefined) => (o instanceof CborUInt ? Number(o.num) : -1);
        switch (tag(sq[0])) {
            case 0: return tip ? new CborArray([new CborUInt(tip.slot), new CborBytes(Uint8Array.from(Buffer.from(tip.hashHex, "hex")))]) : new CborArray([]);
            case 1: return new CborUInt(tip ? BigInt(Number(calculatePreProdCardanoEpoch(Number(tip.slot)))) : 0n);
            case 3: {
                const epoch = tip ? Number(calculatePreProdCardanoEpoch(Number(tip.slot))) : 0;
                const raw = (await readEpochParamsRaw(epoch)) ?? (await readEpochParamsRaw(epoch - 1));
                if (!raw) throw new LsqUnanswerable(`no protocol parameters for epoch ${epoch}`);
                return conwayPParamsCbor(raw);
            }
            case 6: {
                const addrs = setItems(sq[1]).map((a) => (a instanceof CborBytes ? addressString(a.bytes) : null)).filter((a): a is string => !!a);
                if (!addrs.length) return new CborMap([]);
                const ur = ledgerUtxoReads();
                const rows: unknown[][] = ur
                    ? addrs.flatMap((a) => ur.byAddress(a).map((u) => [u.utxo_ref, u.tx_out])).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                    : (await sql.unsafe(`SELECT utxo_ref, tx_out FROM utxo WHERE address IN (${addrs.map(() => "?").join(",")}) ORDER BY utxo_ref`, addrs as any).values()) as unknown[][];
                return utxoMapCbor(rows.map((r) => ({ utxo_ref: String(r[0]), tx_out: String(r[1]) }) as UtxoRowLike));
            }
            case 15: {
                const refs = setItems(sq[1]).map(txInRef).filter((r): r is string => !!r);
                if (!refs.length) return new CborMap([]);
                const ur = ledgerUtxoReads();
                const rows: unknown[][] = ur
                    ? ur.getMany(refs).map((u) => [u.utxo_ref, u.tx_out]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                    : (await sql.unsafe(`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN (${refs.map(() => "?").join(",")}) ORDER BY utxo_ref`, refs as any).values()) as unknown[][];
                return utxoMapCbor(rows.map((r) => ({ utxo_ref: String(r[0]), tx_out: String(r[1]) }) as UtxoRowLike));
            }
            case 16: {
                // every registered pool, a pending retirement included (psStakePoolParams)
                const sr = ledgerStakeReads();
                const rows: unknown[][] = sr
                    ? [...sr.pools().keys()].map((id) => [id]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                    : (await sql`SELECT pool_id FROM pool_params ORDER BY pool_id`.values()) as unknown[][];
                return new CborTag(258, new CborArray(rows.map((r) => new CborBytes(Uint8Array.from(Buffer.from(String(r[0]), "hex"))))));
            }
            default: throw new LsqUnanswerable(`query ${tag(sq[0])} needs the LMDB ledger store (ledgerStore "lmdb" or "dual")`);
        }
    }
}

/** MsgAcquire's point: [] origin, [slot, hash]. */
function pointTarget(o: CborObj | undefined): LsqTarget | null {
    if (!(o instanceof CborArray)) return null;
    if (o.array.length === 0) return { kind: "origin" };
    const [s, h] = o.array;
    if (!(s instanceof CborUInt) || !(h instanceof CborBytes)) return null;
    return { kind: "point", slot: BigInt(s.num), hash: Buffer.from(h.bytes).toString("hex") };
}

function describe(q: CborObj): string {
    return JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex").slice(0, 16) : v))?.slice(0, 160) ?? "?";
}
