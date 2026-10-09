/**
 * Shared pieces of the UTxO RPC services: block refs, UTxO and block conversion with input
 * resolution, field masks, limits and a small async queue for the streams.
 */
import { Cbor } from "@harmoniclabs/cbor";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Message } from "@bufbuild/protobuf";
import { cardano, query } from "@utxorpc/spec";
import type { BlockRecord, BlockStore } from "../../storage/blockStore";
import { selectedTip } from "../../storage/blockReads";
import { prevHashOf } from "../../storage/volatileStore";
import type { UtxoReads, UtxoRecord } from "../../ledger/utxoStore";
import { txOutCbor } from "../../network/n2c/utxoCbor";
import { blockMsg, blockTxs, fromHexBytes, txOutputFromBytes, u8, type BlockTx, type InputResolver } from "./mapper";
import { heightOf, type Point } from "./chain";
import type { UtxorpcProvider } from "./provider";

export interface UtxorpcLimits {
    /** Block refs per FetchBlock / FollowTip / WatchTx intersect (Dingo: 100). */
    maxBlockRefs: number;
    /** Keys per ReadUtxos / ReadData (Dingo: 1000). */
    maxUtxoKeys: number;
    /** Items per SearchUtxos page, also the default when the request sets none (Dingo: 10000). */
    maxSearchItems: number;
    /** Index entries a SearchUtxos predicate may touch before it is refused as too broad. */
    maxSearchScan: number;
    /** Blocks per DumpHistory page. */
    maxHistoryItems: number;
    /** Request message size bound (bytes, Dingo: 1 MiB). */
    maxRequestBytes: number;
}

export const DEFAULT_LIMITS: UtxorpcLimits = { maxBlockRefs: 100, maxUtxoKeys: 1000, maxSearchItems: 10_000, maxSearchScan: 100_000, maxHistoryItems: 100, maxRequestBytes: 1 << 20 };

export const bad = (msg: string) => new ConnectError(msg, Code.InvalidArgument);
export const notFound = (msg: string) => new ConnectError(msg, Code.NotFound);
export const unavailable = (msg: string) => new ConnectError(msg, Code.Unavailable);

export function needStore(p: UtxorpcProvider): BlockStore {
    const s = p.blockStore();
    if (!s) throw unavailable("the node has no block store");
    return s;
}
export function needUtxos(p: UtxorpcProvider): UtxoReads {
    const r = p.utxos();
    if (!r) throw unavailable("UTxO queries need the LMDB ledger store (ledgerStore \"lmdb\")");
    return r;
}

/** A block's ref fields (slot, hash, height, ms timestamp). */
export function refFields(p: UtxorpcProvider, pt: Point): { slot: bigint; hash: Uint8Array<ArrayBuffer>; height: bigint; timestamp: bigint } {
    return { slot: pt.slot, hash: u8(pt.hash), height: pt.height, timestamp: pt.hash.length ? safeMs(p, pt.slot) : 0n };
}
function safeMs(p: UtxorpcProvider, slot: bigint): bigint { try { return p.slotToUnixMs(slot); } catch { return 0n; } }

export async function tipPoint(store: BlockStore): Promise<Point | null> {
    const t = await selectedTip(store);
    return t ? { slot: BigInt(t.slot), hash: t.hash, height: heightOf(t) } : null;
}

export async function ledgerTipChainPoint(p: UtxorpcProvider): Promise<query.ChainPoint | undefined> {
    const s = p.blockStore();
    const t = s ? await tipPoint(s) : null;
    return t ? new query.ChainPoint(refFields(p, t)) : undefined;
}

/** `txid:ix` of a `TxoRef` (32-byte hash). */
export function txoRefKey(r: { hash: Uint8Array; index: number }): string {
    if (r.hash.length !== 32) throw bad(`txo ref hash must be 32 bytes, got ${r.hash.length}`);
    return `${Buffer.from(r.hash).toString("hex")}:${r.index}`;
}

/** A stored output's CBOR: the record's output as a Babbage/Conway map (the store keeps its fields, not its bytes). */
export function utxoNativeBytes(r: UtxoRecord): Uint8Array | null {
    const out = txOutCbor(JSON.parse(r.tx_out));
    return out ? Cbor.encode(out).toBuffer() : null;
}

export function utxoToAny(r: UtxoRecord): query.AnyUtxoData | null {
    const bytes = utxoNativeBytes(r);
    if (!bytes) return null;
    const [id, ix] = r.utxo_ref.split(":");
    return new query.AnyUtxoData({
        nativeBytes: u8(bytes),
        txoRef: new query.TxoRef({ hash: fromHexBytes(id!), index: Number(ix) }),
        parsedState: { case: "cardano", value: txOutputFromBytes(bytes) },
    });
}

/**
 * Input resolution for a block's transactions: the ledger state before the block (its parent's,
 * when the ledger store still holds it as a volatile block or the anchor), else the current UTxO set.
 */
export function resolverFor(p: UtxorpcProvider, block: BlockRecord | null): InputResolver {
    const parent = block ? prevHashOf(block.bytes) : null;
    const before = parent ? p.utxosAfter(parent) : null;
    const now = p.utxos();
    return (refs) => {
        const out = new Map<string, Uint8Array>();
        for (const ref of refs) {
            const r = before?.get(ref) ?? now?.get(ref);
            if (!r) continue;
            try { const b = utxoNativeBytes(r); if (b) out.set(ref, b); } catch { /* unreadable record */ }
        }
        return out;
    };
}

export interface MappedBlock { block: cardano.Block; txs: BlockTx[]; point: Point }

export function mapBlock(p: UtxorpcProvider, b: BlockRecord, opts: { resolve: boolean }): MappedBlock {
    const point: Point = { slot: BigInt(b.slot), hash: b.hash, height: heightOf(b) };
    const txs = blockTxs(b.bytes, opts.resolve ? resolverFor(p, b) : undefined);
    return { block: blockMsg({ slot: b.slot, hash: b.hash, height: point.height, timestampMs: safeMs(p, point.slot), txs }), txs, point };
}

// ---------------------------------------------------------------- field masks

type Tree = Map<string, Tree | null>;
/** Duck-typed: the spec package may carry its own copy of @bufbuild/protobuf. */
const isMessage = (v: unknown): boolean => !!v && typeof (v as { getType?: unknown }).getType === "function";
function maskTree(paths: string[]): Tree {
    const root: Tree = new Map();
    for (const path of paths) {
        let node = root;
        const parts = path.split(".").filter(Boolean);
        parts.forEach((part, i) => {
            if (i === parts.length - 1) { node.set(part, null); return; }
            const cur = node.get(part);
            if (cur === null) return; // a shorter path already keeps the whole field
            const next: Tree = cur ?? new Map();
            node.set(part, next);
            node = next;
        });
    }
    return root;
}

function pick<T extends Message<T>>(msg: T, tree: Tree): T {
    const type = msg.getType();
    const out = new type() as any;
    const src = msg as any;
    for (const [name, sub] of tree) {
        const f = type.fields.list().find((x) => x.name === name || x.jsonName === name || x.localName === name);
        if (!f) continue;
        if (f.oneof) {
            const o = src[f.oneof.localName];
            if (o?.case !== f.localName) continue;
            out[f.oneof.localName] = { case: o.case, value: sub && isMessage(o.value) ? pick(o.value as any, sub) : o.value };
            continue;
        }
        const v = src[f.localName];
        if (sub && f.kind === "message") {
            if (Array.isArray(v)) out[f.localName] = v.map((x: any) => pick(x, sub));
            else if (v) out[f.localName] = pick(v, sub);
        } else out[f.localName] = v;
    }
    return out as T;
}

/** Keep only the masked fields (paths relative to the response, snake_case or camelCase); no mask keeps everything. */
export function applyMask<T extends Message<T>>(msg: T, mask: { paths: string[] } | undefined): T {
    if (!mask || !mask.paths.length) return msg;
    return pick(msg, maskTree(mask.paths));
}

// ---------------------------------------------------------------- streams

/** A push queue an async generator drains (several producers, one consumer). */
export class AsyncQueue<T> {
    private items: T[] = [];
    private waiter: (() => void) | null = null;
    private closed = false;
    private error: unknown = null;
    push(x: T): void { this.items.push(x); this.wake(); }
    fail(err: unknown): void { this.error = err; this.closed = true; this.wake(); }
    close(): void { this.closed = true; this.wake(); }
    private wake(): void { const w = this.waiter; this.waiter = null; w?.(); }
    async *drain(signal: AbortSignal): AsyncGenerator<T> {
        const onAbort = () => this.close();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            for (;;) {
                while (this.items.length) yield this.items.shift()!;
                if (this.closed) { if (this.error) throw this.error; return; }
                await new Promise<void>((r) => { this.waiter = r; });
            }
        } finally { signal.removeEventListener("abort", onAbort); }
    }
}

/** Resolves on the next chain change, after `pollMs`, or when the signal aborts. */
export function chainWaiter(p: UtxorpcProvider, pollMs = 1000): (signal: AbortSignal) => Promise<void> {
    return (signal) => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); unsub(); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, pollMs);
        const unsub = p.onChainChange(finish);
        signal.addEventListener("abort", finish, { once: true });
    });
}
