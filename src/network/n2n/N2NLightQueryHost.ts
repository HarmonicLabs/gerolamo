/**
 * Gerolamo light-query mini-protocol (mux protocol 7 on N2N connections, responder side), served to every
 * inbound N2N peer — over TCP and over the WebSocket bearer. It carries the two facts a browser
 * light client cannot derive from headers alone and that the standard N2N protocols do not
 * carry: the epoch nonce (η0) and a pool's active stake for the leader check.
 * docs/PLAN_BROWSER_NODE.md stage 2. cardano-nodes never open it on N2N; the host is inert for them.
 *
 * Wire (CBOR, one message per request/reply):
 *   [0, epoch]                → [1, epoch, nonce(32) | null]
 *   [2, epoch, poolId(28)]    → [3, epoch, poolStake u64 | null, totalActiveStake u64 | null, activeSlotsCoeffNum, activeSlotsCoeffDen]
 *   [4]                       → [5, network magic, 1, capabilities]  (hello; capabilities is a map of the request
 *                               types this host serves: {"nonce": true, "stake": true, "chunk": bool,
 *                               "blockfrost": {"rate": n, "window_ms": n, "max_body": n}}; version 0 had no map)
 *   [6, chunkNo]              → [7, chunkNo, chunk bytes, primary bytes, secondary bytes] | [7, chunkNo, null, null, null]
 *                               (a complete immutable chunk from the relay's block store, for a browser to check
 *                               against Mithril-certified digests and anchor on its last block)
 *   [8, id, path]             → [9, id, status, body]   a read-only Blockfrost query (`path` under /api/v0, e.g.
 *                               "/addresses/addr…/utxos"), answered by the node's own Blockfrost API; `body` is
 *                               its JSON text. GET only, at most QUERY_RATE per QUERY_WINDOW_MS per peer, bodies over
 *                               QUERY_MAX_BODY bytes answered 413. A browser node asks here for what it does not
 *                               hold itself (ledger state, blocks before its start point).
 *   anything else             → [255, "text"]
 */
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import type { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { getEpochNonce } from "../../db";
import { poolStakeForEpoch } from "../../db/leaderState";
import { getNodeBlockStore } from "../../storage/nodeBlockStore";
import { chunkFileName } from "../../storage/chunkFormat";
import { join } from "node:path";
import { logger } from "../../utils/logger";
import { sendN2NResponder } from "./N2NDirection";
import { handleMiniBlockfrost } from "../../api/miniBlockfrost";

/** Blockfrost queries per peer: at most QUERY_RATE in any QUERY_WINDOW_MS, bodies up to QUERY_MAX_BODY bytes. */
export const QUERY_RATE = 30;
export const QUERY_WINDOW_MS = 10_000;
export const QUERY_MAX_BODY = 512 * 1024;
const QUERY_MAX_PATH = 1024;

/**
 * Mux protocol number. The multiplexer library only forwards known mini-protocol numbers, so the
 * light query rides on 7 (the node-to-client LocalStateQuery number), which never appears on a
 * node-to-node connection: cardano-nodes do not open it there and Gerolamo hosts nothing else on it.
 */
export const LIGHT_QUERY_PROTOCOL = 7;
const log = logger.child("n2n.lightquery");

export interface LightQueryDeps {
    networkMagic: number;
    activeSlotsCoeff: number; // e.g. 0.05
    /** Network name for the Blockfrost answers ("preview", ...). */
    network?: string;
    /** Answers a Blockfrost GET; defaults to the node's own API (tests inject one). */
    blockfrost?: (path: string) => Promise<{ status: number; body: string }>;
}

/** The node's Blockfrost API as one GET: `path` is under /api/v0 ("/blocks/latest"). */
async function localBlockfrost(path: string, network?: string): Promise<{ status: number; body: string }> {
    const url = new URL("http://light-query.local/api/v0" + path);
    const res = await handleMiniBlockfrost(new Request(url, { method: "GET" }), url, { network });
    if (!res) return { status: 404, body: JSON.stringify({ status_code: 404, error: "Not Found", message: "unknown path" }) };
    return { status: res.status, body: await res.text() };
}

/** Per-epoch stake distribution cache shared by all clients (one read per epoch). */
const distCache = new Map<number, Promise<Awaited<ReturnType<typeof poolStakeForEpoch>>>>();
function distributionFor(epoch: number) {
    let p = distCache.get(epoch);
    if (!p) {
        p = poolStakeForEpoch(epoch);
        distCache.set(epoch, p);
        if (distCache.size > 4) distCache.delete(distCache.keys().next().value!);
    }
    return p;
}

function coeffFraction(f: number): [bigint, bigint] {
    const s = f.toString();
    const dot = s.indexOf(".");
    if (dot < 0) return [BigInt(s), 1n];
    const frac = s.slice(dot + 1);
    return [BigInt(s.slice(0, dot) + frac), 10n ** BigInt(frac.length)];
}

export class N2NLightQueryHost {
    private disposed = false;
    private queued: Uint8Array | null = null;
    private queryTimes: number[] = [];
    /** Requests are answered strictly in arrival order: clients match replies by order, so a fast answer must not
     *  overtake a slow one (a Blockfrost query waiting on the database, say). */
    private chain: Promise<void> = Promise.resolve();
    private readonly onPayload = (payload: Uint8Array) => { this.chain = this.chain.then(() => this.handle(payload)).catch(() => { /* answered with [255] */ }); };

    constructor(private readonly mplexer: Multiplexer, private readonly deps: LightQueryDeps, private readonly peer = "?") {
        this.mplexer.on(LIGHT_QUERY_PROTOCOL as any, this.onPayload);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try { this.mplexer.off(LIGHT_QUERY_PROTOCOL as any, this.onPayload); } catch { /* ignore */ }
    }

    private reply(msg: CborObj): void {
        if (this.disposed) return;
        sendN2NResponder(this.mplexer, LIGHT_QUERY_PROTOCOL as any, Cbor.encode(msg).toBuffer());
    }

    private async handle(payload: Uint8Array): Promise<void> {
        if (this.disposed) return;
        const bytes = this.queued ? Uint8Array.from([...this.queued, ...payload]) : payload;
        this.queued = null;
        let offset = 0;
        while (offset < bytes.length) {
            let parsed: { parsed: CborObj; offset: number };
            try { parsed = Cbor.parseWithOffset(bytes.subarray(offset)); } catch { this.queued = bytes.subarray(offset).slice(); return; }
            offset += parsed.offset;
            await this.answer(parsed.parsed);
        }
    }

    /** The request types this host serves, announced in the hello reply so clients never probe. */
    private capabilities(): CborMap {
        const t = (s: string) => new CborText(s), yes = new CborSimple(true);
        return new CborMap([
            { k: t("nonce"), v: yes },
            { k: t("stake"), v: yes },
            { k: t("chunk"), v: new CborSimple(!!getNodeBlockStore()) },
            { k: t("blockfrost"), v: new CborMap([
                { k: t("rate"), v: new CborUInt(QUERY_RATE) },
                { k: t("window_ms"), v: new CborUInt(QUERY_WINDOW_MS) },
                { k: t("max_body"), v: new CborUInt(QUERY_MAX_BODY) },
            ]) },
        ]);
    }

    /** One read-only Blockfrost query, rate-limited per peer and size-capped. */
    private async query(path: string): Promise<{ status: number; body: string }> {
        const err = (status: number, error: string, message: string) => ({ status, body: JSON.stringify({ status_code: status, error, message }) });
        if (typeof path !== "string" || !path.startsWith("/") || path.length > QUERY_MAX_PATH || path.includes(".."))
            return err(400, "Bad Request", "path must start with / and stay under /api/v0");
        const now = Date.now();
        this.queryTimes = this.queryTimes.filter((t) => now - t < QUERY_WINDOW_MS);
        if (this.queryTimes.length >= QUERY_RATE) return err(429, "Too Many Requests", `at most ${QUERY_RATE} queries per ${QUERY_WINDOW_MS / 1000} s`);
        this.queryTimes.push(now);
        const res = await (this.deps.blockfrost ?? ((p: string) => localBlockfrost(p, this.deps.network)))(path);
        if (res.body.length > QUERY_MAX_BODY) return err(413, "Payload Too Large", `answer over ${QUERY_MAX_BODY} bytes; ask for a page (?count=, ?page=)`);
        return res;
    }

    private async answer(q: CborObj): Promise<void> {
        const arr = q instanceof CborArray ? q.array : null;
        const tag = arr && arr[0] instanceof CborUInt ? Number(arr[0].num) : -1;
        try {
            if (tag === 4) { this.reply(new CborArray([new CborUInt(5), new CborUInt(this.deps.networkMagic), new CborUInt(1), this.capabilities()])); return; }
            if (tag === 0 && arr![1] instanceof CborUInt) {
                const epoch = Number(arr![1].num);
                const hexNonce = await getEpochNonce(epoch);
                this.reply(new CborArray([new CborUInt(1), new CborUInt(epoch), hexNonce ? new CborBytes(Uint8Array.from(Buffer.from(String(hexNonce), "hex"))) : new CborSimple(null)]));
                return;
            }
            if (tag === 2 && arr![1] instanceof CborUInt && arr![2] instanceof CborBytes) {
                const epoch = Number(arr![1].num);
                const poolId = Buffer.from(arr![2].bytes).toString("hex");
                const dist = await distributionFor(epoch);
                const stake = dist?.stake.get(poolId) ?? null;
                const [n, d] = coeffFraction(this.deps.activeSlotsCoeff);
                this.reply(new CborArray([new CborUInt(3), new CborUInt(epoch), stake == null ? new CborSimple(null) : new CborUInt(stake), dist ? new CborUInt(dist.total) : new CborSimple(null), new CborUInt(n), new CborUInt(d)]));
                return;
            }
            if (tag === 6 && arr![1] instanceof CborUInt) {
                const n = Number(arr![1].num);
                const store = getNodeBlockStore();
                const tip = store ? await store.immutableTip() : null;
                const complete = store && tip && n < Math.floor(tip.slot / store.chunks.chunkSlots); // only finished chunks: their bytes are final
                if (!store || !complete) { this.reply(new CborArray([new CborUInt(7), new CborUInt(n), new CborSimple(null), new CborSimple(null), new CborSimple(null)])); return; }
                const dir = store.chunks.dir;
                const files = await Promise.all((["chunk", "primary", "secondary"] as const).map((e) => Bun.file(join(dir, chunkFileName(n, e))).bytes().catch(() => null)));
                if (files.some((f) => !f)) { this.reply(new CborArray([new CborUInt(7), new CborUInt(n), new CborSimple(null), new CborSimple(null), new CborSimple(null)])); return; }
                this.reply(new CborArray([new CborUInt(7), new CborUInt(n), ...files.map((f) => new CborBytes(f!))]));
                return;
            }
            if (tag === 8 && arr![1] instanceof CborUInt && arr![2] instanceof CborText) {
                const id = arr![1];
                const { status, body } = await this.query(arr![2].text);
                this.reply(new CborArray([new CborUInt(9), id, new CborUInt(status), new CborText(body)]));
                return;
            }
            this.reply(new CborArray([new CborUInt(255), new CborText(`unknown light query tag ${tag}`)]));
        } catch (err) {
            log.warn(`light query from ${this.peer} failed: ${(err as Error).message}`);
            this.reply(new CborArray([new CborUInt(255), new CborText((err as Error).message.slice(0, 200))]));
        }
    }
}
