/**
 * tx-submission2 messages as cardano-node encodes and decodes them on node-to-node connections.
 * Found by probing cardano-node 11.0.1 (2026-09-10): a transaction id is the hard-fork
 * combinator's `[eraIndex, hash]`, a transaction is `[eraIndex, #6.24(txBytes)]`, and the id and
 * transaction lists of MsgReplyTxIds / MsgRequestTxs / MsgReplyTxs are indefinite-length arrays —
 * the Haskell decoder accepts nothing else and closes the connection on a definite list.
 * @harmoniclabs/ouroboros-miniprotocols-ts encodes bare hashes in definite lists and decodes the
 * request's blocking flag (a CBOR boolean) as false, hence this module.
 */
import { getHardForkHistory } from "../consensus/hfc/hfcNode";
import { eraIndexAt } from "../consensus/hfc/eraOfTip";
import { Cbor, CborArray, CborBytes, type CborObj, CborSimple, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { epochForSlot, getEpochNetwork } from "../utils/epochFromSlotCalculations";
import { slotAt } from "../pool/slotClock";

/** Hard-fork combinator era index: Byron 0, Shelley 1, Allegra 2, Mary 3, Alonzo 4, Babbage 5, Conway 6. */
export type HfcEraIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TxIdRequest { kind: "requestTxIds"; blocking: boolean; ack: number; req: number }
export interface TxRequest { kind: "requestTxs"; ids: Uint8Array[] }
export type TxSubmissionServerMessage = TxIdRequest | TxRequest | { kind: "other"; tag: number };

/** Bytes of a mempool hash whatever view the mempool hands out (Int32Array, Uint8Array, plain array). */
export function hashBytes(h: any): Uint8Array {
    if (h instanceof Uint8Array) return h;
    if (ArrayBuffer.isView(h)) return new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
    return new Uint8Array(h);
}

/** Every message in a chunk of the tx-submission mini-protocol (the server side sends requests). */
export function parseTxSubmissionMessages(chunk: Uint8Array): TxSubmissionServerMessage[] {
    const out: TxSubmissionServerMessage[] = [];
    let rest: Uint8Array = chunk;
    while (rest.length > 0) {
        let parsed: { parsed: CborObj; offset: number };
        try { parsed = Cbor.parseWithOffset(rest); } catch { break; }
        const m = parsed.parsed;
        if (m instanceof CborArray && m.array[0] instanceof CborUInt) {
            const tag = Number(m.array[0].num);
            if (tag === 0 && m.array.length === 4) {
                const b = m.array[1];
                out.push({
                    kind: "requestTxIds",
                    blocking: b instanceof CborSimple ? b.simple === true || b.simple === 1 : false,
                    ack: m.array[2] instanceof CborUInt ? Number(m.array[2].num) : 0,
                    req: m.array[3] instanceof CborUInt ? Number(m.array[3].num) : 0,
                });
            } else if (tag === 2 && m.array[1] instanceof CborArray) {
                const ids: Uint8Array[] = [];
                for (const id of m.array[1].array) {
                    if (id instanceof CborArray && id.array[1] instanceof CborBytes) ids.push(id.array[1].bytes); // [eraIndex, hash]
                    else if (id instanceof CborBytes) ids.push(id.bytes);
                }
                out.push({ kind: "requestTxs", ids });
            } else out.push({ kind: "other", tag });
        }
        if (parsed.offset <= 0 || parsed.offset >= rest.length) break;
        rest = rest.subarray(parsed.offset);
    }
    return out;
}

/** MsgReplyTxIds = [1, 9f [[eraIndex, hash], size] … ff] */
export function encodeReplyTxIds(era: HfcEraIndex, entries: Array<{ hash: Uint8Array; size: number }>): Uint8Array {
    const list = entries.map((e) => new CborArray([new CborArray([new CborUInt(BigInt(era)), new CborBytes(e.hash)]), new CborUInt(BigInt(e.size))]));
    return Cbor.encode(new CborArray([new CborUInt(1n), new CborArray(list, { indefinite: true })])).toBuffer();
}

/** MsgReplyTxs = [3, 9f [eraIndex, #6.24(txBytes)] … ff] */
export function encodeReplyTxs(era: HfcEraIndex, txs: Uint8Array[]): Uint8Array {
    const list = txs.map((t) => new CborArray([new CborUInt(BigInt(era)), new CborTag(24, new CborBytes(t))]));
    return Cbor.encode(new CborArray([new CborUInt(3n), new CborArray(list, { indefinite: true })])).toBuffer();
}

/** MsgInit = [6] */
export function encodeInit(): Uint8Array {
    return Cbor.encode(new CborArray([new CborUInt(6n)])).toBuffer();
}

/** Hard-fork-combinator era index of the current wall-clock epoch (Byron 0 … Babbage 5, Conway 6). */
export function hfcEraIndexNow(): HfcEraIndex {
    const net = getEpochNetwork();
    const hfc = getHardForkHistory(); // ledger-driven era history (consensus/hfc); the table is the fallback
    const conwayEpoch = net === "preview" ? 646 : net === "preprod" ? 163 : 507;
    const epoch = Number(epochForSlot(slotAt(Date.now(), net), net));
    const table: HfcEraIndex = epoch >= conwayEpoch ? 6 : 5;
    // the known history is the floor (bug 237: an incomplete history answered Alonzo on preview)
    return eraIndexAt(hfc, slotAt(Date.now(), net), table) as HfcEraIndex;
}

// ───────────── the server (responder) side: what an inbound peer sends us, what we ask it ─────────────

export interface TxIdAnnouncement { hash: Uint8Array; size: number }
export type TxSubmissionClientMessage =
    | { kind: "init" }
    | { kind: "replyTxIds"; ids: TxIdAnnouncement[] }
    | { kind: "replyTxs"; txs: Uint8Array[] }
    | { kind: "done" }
    | { kind: "other"; tag: number };

/** Every message in a chunk sent by the client (initiator) side of tx-submission. */
export function parseTxSubmissionClientMessages(chunk: Uint8Array): TxSubmissionClientMessage[] {
    const out: TxSubmissionClientMessage[] = [];
    let rest: Uint8Array = chunk;
    while (rest.length > 0) {
        let parsed: { parsed: CborObj; offset: number };
        try { parsed = Cbor.parseWithOffset(rest); } catch { break; }
        const m = parsed.parsed;
        if (m instanceof CborArray && m.array[0] instanceof CborUInt) {
            const tag = Number(m.array[0].num);
            if (tag === 6) out.push({ kind: "init" });
            else if (tag === 4) out.push({ kind: "done" });
            else if (tag === 1 && m.array[1] instanceof CborArray) {
                const ids: TxIdAnnouncement[] = [];
                for (const e of m.array[1].array) {
                    if (!(e instanceof CborArray) || e.array.length < 2) continue;
                    const id = e.array[0];
                    const hash = id instanceof CborArray && id.array[1] instanceof CborBytes ? id.array[1].bytes : id instanceof CborBytes ? id.bytes : null;
                    if (hash && e.array[1] instanceof CborUInt) ids.push({ hash, size: Number(e.array[1].num) });
                }
                out.push({ kind: "replyTxIds", ids });
            } else if (tag === 3 && m.array[1] instanceof CborArray) {
                const txs: Uint8Array[] = [];
                for (const e of m.array[1].array) {
                    const body = e instanceof CborArray ? e.array[1] : e; // [eraIndex, #6.24(bytes)]
                    const inner = body instanceof CborTag ? body.data : body;
                    if (inner instanceof CborBytes) txs.push(inner.bytes);
                }
                out.push({ kind: "replyTxs", txs });
            } else out.push({ kind: "other", tag });
        }
        if (parsed.offset <= 0 || parsed.offset >= rest.length) break;
        rest = rest.subarray(parsed.offset);
    }
    return out;
}

/** MsgRequestTxIds = [0, blocking, ack, req] */
export function encodeRequestTxIds(blocking: boolean, ack: number, req: number): Uint8Array {
    return Cbor.encode(new CborArray([new CborUInt(0n), new CborSimple(blocking), new CborUInt(BigInt(ack)), new CborUInt(BigInt(req))])).toBuffer();
}

/** MsgRequestTxs = [2, 9f [eraIndex, hash] … ff] */
export function encodeRequestTxs(era: HfcEraIndex, hashes: Uint8Array[]): Uint8Array {
    const list = hashes.map((h) => new CborArray([new CborUInt(BigInt(era)), new CborBytes(h)]));
    return Cbor.encode(new CborArray([new CborUInt(2n), new CborArray(list, { indefinite: true })])).toBuffer();
}

/**
 * What we have announced to one peer (the client side of tx-submission). A transaction id may be
 * announced to a peer once per connection: the peer acknowledges the oldest `ack` ids of the
 * unacknowledged window with each request, and an id announced again — acknowledged or not — is
 * a protocol violation that cardano-node answers by closing the connection (preview 2026-09-10
 * 12:38 UTC: every hot peer reset within a second of our second announcement round).
 */
export class AnnounceWindow {
    private readonly unacked: string[] = [];
    private readonly ever = new Set<string>();
    constructor(private readonly maxRemembered = 50_000) {}
    /** The peer's request acknowledged the oldest `ack` unacknowledged ids. */
    acknowledge(ack: number): void { this.unacked.splice(0, Math.max(0, ack)); }
    get outstanding(): number { return this.unacked.length; }
    /** Ids never announced to this peer, in the mempool's order. */
    fresh(hashesHex: string[]): string[] { return hashesHex.filter((h) => !this.ever.has(h)); }
    /** Record an announcement of `hashesHex` (already filtered by `fresh`). */
    announce(hashesHex: string[]): void {
        for (const h of hashesHex) { this.unacked.push(h); this.ever.add(h); }
        if (this.ever.size > this.maxRemembered) { // bounded: forget the oldest half (they are long acknowledged and mined or expired)
            const keep = [...this.ever].slice(-Math.floor(this.maxRemembered / 2));
            this.ever.clear(); for (const h of keep) this.ever.add(h);
        }
    }
}
