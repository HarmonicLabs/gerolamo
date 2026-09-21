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
    QryAcquire,
    QryAcquired,
    QryDone,
    QryFailure,
    QryFailureReason,
    QryQuery,
    QryReAcquire,
    QryRelease,
    QryResult,
    localStateQueryMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
// Not re-exported at package root.
import type { IChainDb } from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/interfaces/IChainDb.js";
import { getChainTipFromHeader } from "../../db";
import { ledgerStakeReads, ledgerUtxoReads } from "../../ledger/nodeLedgerStore";
import { sql } from "../../sql";
import { CborBytes, CborTag } from "@harmoniclabs/cbor";
import { HFC_ERA_NAMES, encodeUtcTime, eraSummaries, networkFromMagic, systemStartOf, type EraHistoryNetwork } from "./eraHistory";
import { calculatePreProdCardanoEpoch } from "../../utils/epochFromSlotCalculations";
import { readEpochParamsRaw } from "../../consensus/epochParams";
import { conwayPParamsCbor } from "./pparamsCbor";
import { addressString, txInRef, utxoMapCbor, type UtxoRowLike } from "./utxoCbor";
import { logger } from "../../utils/logger";

const log = logger.child("n2c.localstatequery");
const PROTO = MiniProtocol.LocalStateQuery;

/**
 * N2C LocalStateQuery server (protocol 7) — minimal data-node surface.
 *
 * Supports: Acquire (tip/point), Acquired, Release, Done.
 * Query: returns a small CBOR map with tip slot/blockNo; unknown queries
 * still get a QryResult so clients don't hang (not full ledger parity).
 */
export class LocalStateQueryHost {
    readonly mplexer: Multiplexer;
    readonly chainDb: IChainDb;
    private acquired = false;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;

    private readonly network: EraHistoryNetwork | null;

    constructor(mplexer: Multiplexer, chainDb: IChainDb, networkMagic?: number) {
        this.mplexer = mplexer;
        this.chainDb = chainDb;
        this.network = networkMagic == null ? null : networkFromMagic(networkMagic);
        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.acquired = false;
        try {
            this.mplexer.off(PROTO, this.listener);
        } catch {
            /* ignore */
        }
    }

    private send(msg: { toCbor: () => { toBuffer: () => Uint8Array } }): void {
        this.mplexer.send(msg.toCbor().toBuffer(), {
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
            try {
                const msg = localStateQueryMessageFromCborObj(parsed);
                void this.handle(msg);
            } catch (err) {
                log.error("LocalStateQuery parse error:", err);
            }
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: unknown): Promise<void> {
        if (msg instanceof QryDone) {
            this.dispose();
            return;
        }
        if (msg instanceof QryRelease) {
            this.acquired = false;
            return;
        }
        if (msg instanceof QryAcquire || msg instanceof QryReAcquire) {
            await this.handleAcquire(msg);
            return;
        }
        if (msg instanceof QryQuery) {
            await this.handleQuery(msg);
        }
    }

    private async handleAcquire(msg: QryAcquire | QryReAcquire): Promise<void> {
        const tip = await this.chainDb.getTip();
        const point = (msg as QryAcquire).point;
        if (point?.blockHeader) {
            const found = await this.chainDb.findIntersect(point);
            if (!found) {
                this.acquired = false;
                this.send(
                    new QryFailure({
                        reason: QryFailureReason.pointNotOnChain,
                    }),
                );
                return;
            }
        }
        this.acquired = true;
        this.send(new QryAcquired());
        log.info(
            `LSQ acquired tip.blockNo=${tip.blockNo} point=${point ? "explicit" : "tip"}`,
        );
    }

    private async handleQuery(msg: QryQuery): Promise<void> {
        let result: CborObj;
        try {
            result = await this.answer(msg.query);
        } catch (err) {
            log.warn("LocalStateQuery: query failed:", err);
            result = new CborArray([]);
        }
        this.send(new QryResult({ result }));
    }

    /**
     * The queries cardano-cli and wallets send, encoded as ouroboros-consensus does (captured
     * from a cardano-node with scripts/n2c-oracle.ts). Query = [1] GetSystemStart · [2]
     * GetChainBlockNo · [3] GetChainPoint · [0, [2, [1]]] GetCurrentEra · [0, [2, [0]]]
     * GetInterpreter · [0, [0, [era, q]]] QueryIfCurrent (Right r = [r]; wrong era =
     * [[qEra, name], [curEra, name]]); inside: [0] GetLedgerTip · [1] GetEpochNo · [3] GetCurrentPParams
     * (Conway record) · [6, set<address>] GetUTxOByAddress · [15, set<txin>] GetUTxOByTxIn · [16] GetStakePools. Unknown queries get an empty array (the client fails
     * to decode instead of hanging).
     */
    private async answer(q: CborObj): Promise<CborObj> {
        const setItems = (o: CborObj | undefined): CborObj[] => {
            const inner = o instanceof CborTag ? o.data : o;
            return inner instanceof CborArray ? inner.array : [];
        };
        const tag = (o: CborObj | undefined) => (o instanceof CborUInt ? Number(o.num) : -1);
        const arr = (o: CborObj | undefined) => (o instanceof CborArray ? o.array : null);
        const top = arr(q);
        if (!top) return new CborArray([]);
        const tip = await getChainTipFromHeader();
        const net = this.network;
        switch (tag(top[0])) {
            case 1: return net ? encodeUtcTime(systemStartOf(net)) : new CborArray([]);
            case 2: return tip ? new CborArray([new CborUInt(1), new CborUInt(tip.blockNumber)]) : new CborArray([]);
            case 3: return tip ? new CborArray([new CborUInt(tip.slot), new CborBytes(Uint8Array.from(Buffer.from(tip.hashHex, "hex")))]) : new CborArray([]);
            case 0: {
                const bq = arr(top[1]);
                if (!bq) break;
                const eraIndex = tip ? Math.max(0, tip.era - 1) : 0; // our era numbering counts the Byron EBB era; the HFC index does not
                if (tag(bq[0]) === 2) {
                    const hq = arr(bq[1]);
                    if (hq && tag(hq[0]) === 1) return new CborUInt(eraIndex);
                    if (hq && tag(hq[0]) === 0 && net) return eraSummaries(net, eraIndex, tip ? Number(calculatePreProdCardanoEpoch(Number(tip.slot))) : undefined);
                    break;
                }
                if (tag(bq[0]) === 0) {
                    const ic = arr(bq[1]);
                    if (!ic) break;
                    const qEra = tag(ic[0]);
                    if (qEra !== eraIndex) {
                        const name = (i: number) => new CborText(HFC_ERA_NAMES[i] ?? `era${i}`);
                        return new CborArray([new CborArray([new CborUInt(qEra), name(qEra)]), new CborArray([new CborUInt(eraIndex), name(eraIndex)])]);
                    }
                    const sq = arr(ic[1]);
                    if (!sq) break;
                    const right = (r: CborObj) => new CborArray([r]);
                    switch (tag(sq[0])) {
                        case 0: return right(tip ? new CborArray([new CborUInt(tip.slot), new CborBytes(Uint8Array.from(Buffer.from(tip.hashHex, "hex")))]) : new CborArray([]));
                        case 1: return right(new CborUInt(tip ? BigInt(Number(calculatePreProdCardanoEpoch(Number(tip.slot)))) : 0n));
                        case 3: {
                            const epoch = tip ? Number(calculatePreProdCardanoEpoch(Number(tip.slot))) : 0;
                            const raw = (await readEpochParamsRaw(epoch)) ?? (await readEpochParamsRaw(epoch - 1));
                            if (!raw) break;
                            return right(conwayPParamsCbor(raw));
                        }
                        case 6: {
                            const addrs = setItems(sq[1]).map((a) => (a instanceof CborBytes ? addressString(a.bytes) : null)).filter((a): a is string => !!a);
                            if (!addrs.length) return right(new CborMap([]));
                            const ur = ledgerUtxoReads();
                            const rows: unknown[][] = ur
                                ? addrs.flatMap((a) => ur.byAddress(a).map((u) => [u.utxo_ref, u.tx_out])).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                                : (await sql.unsafe(`SELECT utxo_ref, tx_out FROM utxo WHERE address IN (${addrs.map(() => "?").join(",")}) ORDER BY utxo_ref`, addrs as any).values()) as unknown[][];
                            return right(utxoMapCbor(rows.map((r) => ({ utxo_ref: String(r[0]), tx_out: String(r[1]) }) as UtxoRowLike)));
                        }
                        case 15: {
                            const refs = setItems(sq[1]).map(txInRef).filter((r): r is string => !!r);
                            if (!refs.length) return right(new CborMap([]));
                            const ur = ledgerUtxoReads();
                            const rows: unknown[][] = ur
                                ? ur.getMany(refs).map((u) => [u.utxo_ref, u.tx_out]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                                : (await sql.unsafe(`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN (${refs.map(() => "?").join(",")}) ORDER BY utxo_ref`, refs as any).values()) as unknown[][];
                            return right(utxoMapCbor(rows.map((r) => ({ utxo_ref: String(r[0]), tx_out: String(r[1]) }) as UtxoRowLike)));
                        }
                        case 16: {
                            const sr = ledgerStakeReads();
                            const rows: unknown[][] = sr
                                ? [...sr.pools()].filter(([, p]) => p.retiringEpoch === null).map(([id]) => [id]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))
                                : (await sql`SELECT pool_id FROM pool_params WHERE retiring_epoch IS NULL ORDER BY pool_id`.values()) as unknown[][];
                            return right(new CborTag(258, new CborArray(rows.map((r) => new CborBytes(Uint8Array.from(Buffer.from(String(r[0]), "hex")))))));
                        }
                        default: break;
                    }
                }
                break;
            }
            default: break;
        }
        log.warn(`LocalStateQuery: unsupported query ${JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 160)}`);
        return new CborArray([]);
    }
}
