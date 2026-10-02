/**
 * Client side of tx-submission2 for the browser node: transactions pasted into the page are
 * offered to the relay over the same WebSocket as chain-sync. The relay (the responder) asks for
 * ids with blocking requests and fetches the bodies it wants; a blocking request is answered only
 * once something is queued. Wire format as cardano-node 11 speaks it (see
 * `src/network/txSubmissionCodec.ts`): ids are `[eraIndex, hash]`, transactions
 * `[eraIndex, #6.24(txBytes)]`, and every list is indefinite-length.
 */
import { Cbor, CborArray, CborBytes, CborSimple, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { MiniProtocol, type Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { arrayElements } from "./cbor";

/** Hard-fork combinator era index of Conway, the era of every public network. */
const CONWAY = 6n;

export interface QueuedTx { id: string; size: number; state: "queued" | "announced" | "fetched" }

/** The transaction id: blake2b-256 of the raw body bytes (element 0 of the transaction array). */
export function txIdOf(tx: Uint8Array): Uint8Array {
    const els = arrayElements(tx, 0);
    if (els.length < 3) throw new Error("not a transaction: expected [body, witnesses, valid, aux]");
    return blake2b_256(tx.subarray(els[0]!.start, els[0]!.end));
}

type ServerMsg = { kind: "ids"; blocking: boolean; ack: number; req: number } | { kind: "txs"; ids: string[] } | { kind: "done" };

function parse(m: CborObj): ServerMsg | null {
    if (!(m instanceof CborArray) || !(m.array[0] instanceof CborUInt)) return null;
    const tag = Number(m.array[0].num);
    if (tag === 0 && m.array.length === 4) {
        const b = m.array[1];
        return { kind: "ids", blocking: b instanceof CborSimple ? b.simple === true || b.simple === 1 : false, ack: Number((m.array[2] as CborUInt).num), req: Number((m.array[3] as CborUInt).num) };
    }
    if (tag === 2 && m.array[1] instanceof CborArray) {
        const ids = m.array[1].array.map((x) => x instanceof CborArray && x.array[1] instanceof CborBytes ? toHex(x.array[1].bytes) : x instanceof CborBytes ? toHex(x.bytes) : "");
        return { kind: "txs", ids };
    }
    if (tag === 4) return { kind: "done" };
    return null;
}

export class TxSubmitClient {
    /** Announced but not yet acknowledged, oldest first (the responder acknowledges in order). */
    private unacked: string[] = [];
    private readonly txs = new Map<string, { bytes: Uint8Array; state: QueuedTx["state"] }>();
    private waiting: { req: number } | null = null;
    private pending: Uint8Array | null = null;
    private readonly onPayload = (p: Uint8Array) => this.receive(p);

    constructor(private readonly mux: Multiplexer, private readonly log: (l: string) => void = () => {}, private readonly onChange: () => void = () => {}) {
        this.mux.on(MiniProtocol.TxSubmission, this.onPayload);
        this.send(new CborArray([new CborUInt(6n)])); // MsgInit
    }

    dispose(): void { try { this.mux.off(MiniProtocol.TxSubmission, this.onPayload); } catch { /* ignore */ } }

    /** Queue a signed transaction (CBOR bytes); returns its id. */
    submit(tx: Uint8Array): string {
        const id = toHex(txIdOf(tx));
        if (!this.txs.has(id)) this.txs.set(id, { bytes: tx, state: "queued" });
        this.log(`tx ${id.slice(0, 16)}… queued (${tx.length} bytes)`);
        this.onChange();
        if (this.waiting) { const w = this.waiting; this.waiting = null; this.replyIds(w.req); }
        return id;
    }

    list(): QueuedTx[] { return [...this.txs].map(([id, t]) => ({ id, size: t.bytes.length, state: t.state })); }

    private send(m: CborObj): void { this.mux.send(Cbor.encode(m).toBuffer(), { protocol: MiniProtocol.TxSubmission, hasAgency: true }); }

    private receive(payload: Uint8Array): void {
        const bytes = this.pending ? concat(this.pending, payload) : payload;
        this.pending = null;
        let off = 0;
        while (off < bytes.length) {
            let p: { parsed: CborObj; offset: number };
            try { p = Cbor.parseWithOffset(bytes.subarray(off)); } catch { this.pending = bytes.slice(off); return; }
            off += p.offset;
            const m = parse(p.parsed);
            if (m?.kind === "ids") this.onRequestIds(m);
            else if (m?.kind === "txs") this.replyTxs(m.ids);
        }
    }

    private onRequestIds(m: { blocking: boolean; ack: number; req: number }): void {
        // acknowledged ids are out of the relay's window: the relay holds them (or dropped them)
        for (const id of this.unacked.splice(0, m.ack)) this.txs.delete(id);
        if (m.ack) this.onChange();
        if (this.fresh().length === 0 && m.blocking) { this.waiting = { req: m.req }; return; } // answered by submit()
        this.replyIds(m.req);
    }

    private fresh(): string[] { return [...this.txs].filter(([, t]) => t.state === "queued").map(([id]) => id); }

    private replyIds(req: number): void {
        const ids = this.fresh().slice(0, req);
        const list = ids.map((id) => {
            const t = this.txs.get(id)!;
            t.state = "announced";
            return new CborArray([new CborArray([new CborUInt(CONWAY), new CborBytes(hexBytes(id))]), new CborUInt(BigInt(t.bytes.length))]);
        });
        this.unacked.push(...ids);
        this.send(new CborArray([new CborUInt(1n), new CborArray(list, { indefinite: true })]));
        if (ids.length) { this.log(`announced ${ids.length} transaction(s) to the relay`); this.onChange(); }
    }

    private replyTxs(ids: string[]): void {
        const list: CborObj[] = [];
        for (const id of ids) {
            const t = this.txs.get(id);
            if (!t) continue;
            t.state = "fetched";
            list.push(new CborArray([new CborUInt(CONWAY), new CborTag(24, new CborBytes(t.bytes))]));
            this.log(`relay fetched tx ${id.slice(0, 16)}…`);
        }
        this.send(new CborArray([new CborUInt(3n), new CborArray(list, { indefinite: true })]));
        this.onChange();
    }
}

function hexBytes(h: string): Uint8Array { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
