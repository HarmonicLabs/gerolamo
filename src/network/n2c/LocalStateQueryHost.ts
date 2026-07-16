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
import { getEpochNonce, getMaxSlot, getUtxoCount } from "../../db";
import { calculatePreProdCardanoEpoch } from "../../utils/epochFromSlotCalculations";
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

    constructor(mplexer: Multiplexer, chainDb: IChainDb) {
        this.mplexer = mplexer;
        this.chainDb = chainDb;
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
            hasAgency: true,
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

    private async handleQuery(_msg: QryQuery): Promise<void> {
        if (!this.acquired) {
            // Not acquired — still answer so clients don't hang; empty result.
            this.send(
                new QryResult({
                    result: new CborArray([new CborUInt(0)]),
                }),
            );
            return;
        }
        const tip = await this.chainDb.getTip();
        const chainSlot = tip.point.blockHeader
            ? BigInt(tip.point.blockHeader.slotNumber)
            : 0n;

        // Enrich with local DB tip/utxo/nonce (data-node surface; not full ledger query.cddl).
        let dbTip = 0n;
        let utxoCount = 0;
        let epochNonce: string | null = null;
        try {
            dbTip = await getMaxSlot();
            utxoCount = await getUtxoCount();
            const epoch = Number(calculatePreProdCardanoEpoch(Number(dbTip || chainSlot)));
            if (Number.isFinite(epoch) && epoch >= 0) {
                epochNonce = await getEpochNonce(epoch);
            }
        } catch (err) {
            log.warn("LSQ enrichment failed (returning tip-only):", err);
        }

        const entries: { k: CborObj; v: CborObj }[] = [
            { k: new CborText("tipSlot"), v: new CborUInt(dbTip || chainSlot) },
            { k: new CborText("tipBlockNo"), v: new CborUInt(tip.blockNo) },
            { k: new CborText("utxoCount"), v: new CborUInt(BigInt(utxoCount)) },
            { k: new CborText("node"), v: new CborText("gerolamo") },
        ];
        if (epochNonce) {
            entries.push({
                k: new CborText("epochNonce"),
                v: new CborText(epochNonce),
            });
        }

        this.send(
            new QryResult({
                result: new CborMap(entries),
            }),
        );
    }
}
