/**
 * Gerolamo browser node, stage 1: a verifying light client over N2N-over-WebSocket.
 *
 * Connects to a Gerolamo relay's WebSocket bearer (`n2n.ws`, docs/PLAN_BROWSER_NODE.md), runs the
 * node-to-node handshake, follows the chain with ChainSync (intersect at the relay's tip or at a
 * given point, RollBackward/RollForward), and for every header: recomputes the header hash
 * (blake2b-256 of the header bytes), checks the prev-hash link to the previous header, then
 * fetches the block with BlockFetch and checks the header's block-body hash against the body
 * (cardano-ledger `hashTxSeq`). No DOM, no Bun APIs: the same module runs in the page and in
 * `scripts/probe.ts` under Bun.
 *
 * Not yet: VRF/KES header validation, ledger rules, persistent storage (OPFS chunk files).
 */
import { CborArray, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import {
    BlockFetchClient,
    ChainPoint,
    ChainSyncClient,
    ChainSyncIntersectFound,
    ChainSyncIntersectNotFound,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    HandshakeAcceptVersion,
    HandshakeClient,
    KeepAliveClient,
    Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { arrayElements, bytesAt, uintAt } from "./cbor";
import { parseHeaderCrypto, verifyHeaderCrypto } from "./headerVerify";
import { LightQueryClient } from "./lightQuery";
import { ChunkWriter, type FileSink } from "./chunkWriter";
import { mithrilAnchor, type MithrilAnchor } from "./mithrilAnchor";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { isSlotLeader } from "../../../src/consensus/rules/leaderMath";
import { epochOfSlot, networkByMagic } from "./networks";

export interface HeaderSummary {
    eraTag: number;          // wire era tag: 2 Shelley … 7 Conway
    slot: number;
    blockNo: number;
    hash: string;            // hex
    prevHash: string | null; // hex
    bodySize: number;
    bodyHash: string;        // hex, from the header
    headerBytes: Uint8Array;
}

export interface NodeStats {
    endpoint: string;
    state: "idle" | "connecting" | "handshake" | "syncing" | "at-tip" | "stopped" | "error";
    version: number | null;
    serverTip: { slot: number; blockNo: number; hash: string } | null;
    intersect: string;
    headers: number;
    linkOk: number;
    linkBad: number;
    blocksFetched: number;
    bodyOk: number;
    bodyBad: number;
    rollbacks: number;
    /** Header cryptography (opcert + KES + VRF against the epoch nonce from the relay API). */
    cryptoOk: number;
    cryptoBad: number;
    cryptoSkipped: number;
    nonceEpoch: number | null;
    /** Leader eligibility (VRF leader value below the pool's stake threshold), stake from the relay over the light-query protocol. */
    leaderOk: number;
    leaderBad: number;
    leaderSkipped: number;
    lightQuery: boolean | null;
    /** Persistent store (chunk files) */
    storedBlocks: number;
    storedBytes: number;
    storedChunks: number;
    resumedFrom: number | null;
    /** Mithril-certified anchor when started that way. */
    anchor: MithrilAnchor | null;
    lastSlot: number | null;
    lastBlockNo: number | null;
    lastHash: string | null;
    bytes: number;
    startedAt: number | null;
    error: string | null;
}

export interface BrowserNodeOptions {
    endpoint: string;                 // ws://host:port or wss://…
    networkMagic: number;
    /** Start from the relay's tip (default), from origin, from a point, or from a Mithril-certified point verified in the browser. */
    start?: "tip" | "origin" | "mithril" | { slot: number; hash: string };
    /** Fetch and verify bodies for every header (default true). */
    fetchBodies?: boolean;
    /** Keep at most this many recent blocks in memory (default 64). */
    keep?: number;
    /** Persist verified blocks as cardano-node chunk files through this sink (OPFS in the page). */
    storeSink?: FileSink;
    /** Slots per chunk for the store (10·k: 4320 preview/preprod, 21600 mainnet). */
    chunkSlots?: number;
    /** Optional HTTP fallback for the epoch nonce (mini-Blockfrost `/api/v0/epochs/{n}`) when the relay lacks the light-query protocol. */
    apiBase?: string;
    log?: (line: string) => void;
    onStats?: (s: NodeStats) => void;
}

const hex = (b: Uint8Array) => toHex(b);
const chunkFileNameFor = (n: number, ext: string) => `${n.toString().padStart(5, "0")}.${ext}`;
/** Header hash of the last 56-byte secondary entry (bytes 16..48). */
const lastEntryHash = (sec: Uint8Array): string | null => (sec.length >= 56 ? toHex(sec.subarray(sec.length - 56 + 16, sec.length - 56 + 48)) : null);
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const fromHexStr = (h: string): Uint8Array => { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return out; };

/** Parse the ChainSync RollForward payload `[eraIdx, #6.24(header)]` into a summary (Shelley-era and later). */
export function summarizeHeader(data: CborObj): HeaderSummary {
    if (!(data instanceof CborArray) || data.array.length < 2) throw new Error("RollForward data is not [era, header]");
    const eraIdx = Number((data.array[0] as CborUInt).num);
    const eraTag = eraIdx + 1; // header era index (Shelley = 1) → wire era tag (Shelley = 2)
    if (eraTag < 2) throw new Error("Byron headers are not handled by the light client yet");
    const tagged = data.array[1];
    const headerBytes: Uint8Array = tagged instanceof CborTag ? (tagged.data as any).bytes : (tagged as any).bytes;
    // header = [header_body, kes_signature]; body layout differs before Babbage
    const [bodyRange] = arrayElements(headerBytes, 0);
    const fields = arrayElements(headerBytes, bodyRange!.start);
    const babbage = eraTag >= 6;
    const slot = Number(uintAt(headerBytes, fields[1]!.start));
    const blockNo = Number(uintAt(headerBytes, fields[0]!.start));
    const prev = headerBytes[fields[2]!.start] === 0xf6 ? null : hex(bytesAt(headerBytes, fields[2]!.start));
    const sizeIdx = babbage ? 6 : 7, hashIdx = babbage ? 7 : 8;
    const bodySize = Number(uintAt(headerBytes, fields[sizeIdx]!.start));
    const bodyHash = hex(bytesAt(headerBytes, fields[hashIdx]!.start));
    return { eraTag, slot, blockNo, hash: hex(new Uint8Array(blake2b_256(headerBytes))), prevHash: prev, bodySize, bodyHash, headerBytes };
}

/** cardano-ledger `hashTxSeq` over the block's body segments (`[era, [hdr, bodies, wits, aux, invalid?]]`). */
export function bodyHashOf(block: Uint8Array): { hash: string; eraTag: number; txs: number } {
    const outer = arrayElements(block, 0);
    const eraTag = Number(uintAt(block, outer[0]!.start));
    const parts = arrayElements(block, outer[1]!.start);
    const seg = (i: number) => block.subarray(parts[i]!.start, parts[i]!.end);
    const h = (b: Uint8Array) => new Uint8Array(blake2b_256(b));
    const hashes = [h(seg(1)), h(seg(2)), h(seg(3))];
    if (eraTag >= 5 && parts.length > 4) hashes.push(h(seg(4))); // Alonzo+: invalid transactions
    const cat = new Uint8Array(hashes.length * 32);
    hashes.forEach((x, i) => cat.set(x, i * 32));
    const bodies = arrayElements(block, parts[1]!.start);
    return { hash: hex(h(cat)), eraTag, txs: bodies.length };
}

export class BrowserNode {
    readonly stats: NodeStats;
    private mux: Multiplexer | null = null;
    private stopped = false;
    private readonly opts: BrowserNodeOptions;
    /** Recent blocks, newest last. */
    readonly recent: Array<{ slot: number; blockNo: number; hash: string; bytes: Uint8Array; txs: number }> = [];

    constructor(opts: BrowserNodeOptions) {
        this.opts = opts;
        this.stats = { endpoint: opts.endpoint, state: "idle", version: null, serverTip: null, intersect: "", headers: 0, linkOk: 0, linkBad: 0, blocksFetched: 0, bodyOk: 0, bodyBad: 0, rollbacks: 0, cryptoOk: 0, cryptoBad: 0, cryptoSkipped: 0, nonceEpoch: null, leaderOk: 0, leaderBad: 0, leaderSkipped: 0, lightQuery: null, storedBlocks: 0, storedBytes: 0, storedChunks: 0, resumedFrom: null, anchor: null, lastSlot: null, lastBlockNo: null, lastHash: null, bytes: 0, startedAt: null, error: null };
    }

    private nonces = new Map<number, Uint8Array | null>();

    /** η0 of an epoch from the relay's `/api/v0/epochs/{n}` (`epoch_nonce`), cached; null when unavailable. */
    private lq: LightQueryClient | null = null;
    private writer: ChunkWriter | null = null;
    private stakeCache = new Map<string, Awaited<ReturnType<LightQueryClient["poolStake"]>>>();

    private async epochNonce(epoch: number): Promise<Uint8Array | null> {
        if (this.nonces.has(epoch)) return this.nonces.get(epoch)!;
        let nonce: Uint8Array | null = null;
        if (this.lq && (await this.lq.supported)) {
            try { nonce = await this.lq.epochNonce(epoch); if (nonce) { this.nonces.set(epoch, nonce); this.stats.nonceEpoch = epoch; this.log(`epoch ${epoch} nonce ${hex(nonce).slice(0, 16)}… over the WebSocket (light query)`); return nonce; } this.log(`epoch ${epoch}: relay has no nonce yet`); }
            catch (e) { this.log(`light query nonce failed: ${(e as Error).message}`); }
        }
        if (!this.opts.apiBase) { this.nonces.set(epoch, null); return null; }
        try {
            const base = this.opts.apiBase.replace(/\/$/, "");
            const r = await fetch(`${base}/api/v0/epochs/${epoch}`);
            let j = r.ok ? await r.json() : null;
            if (!j?.epoch_nonce) { // older relays carry the nonce only on /epochs/latest
                const l = await fetch(`${base}/api/v0/epochs/latest`);
                const lj = l.ok ? await l.json() : null;
                if (lj && Number(lj.epoch) === epoch) j = lj;
            }
            const hexNonce: string | undefined = j?.epoch_nonce;
            if (hexNonce && /^[0-9a-f]{64}$/i.test(hexNonce)) nonce = fromHexStr(hexNonce);
            else this.log(`epoch ${epoch}: no nonce from the relay API`);
        } catch (e) { this.log(`epoch ${epoch}: nonce fetch failed: ${(e as Error).message}`); }
        this.nonces.set(epoch, nonce);
        if (nonce) { this.stats.nonceEpoch = epoch; this.log(`epoch ${epoch} nonce ${hex(nonce).slice(0, 16)}… from the relay API`); }
        return nonce;
    }

    private log(line: string): void { this.opts.log?.(line); }
    private emit(): void { this.opts.onStats?.({ ...this.stats }); }

    async start(): Promise<void> {
        const { endpoint, networkMagic } = this.opts;
        this.stats.state = "connecting"; this.stats.startedAt = Date.now(); this.emit();
        const socket = await new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(endpoint);
            ws.binaryType = "arraybuffer";
            ws.addEventListener("open", () => resolve(ws), { once: true });
            ws.addEventListener("error", () => reject(new Error(`cannot connect to ${endpoint}`)), { once: true });
        });
        let handedOut = false;
        this.mux = new Multiplexer({ protocolType: "node-to-node", connect: () => { if (handedOut) throw new Error("reconnect not supported"); handedOut = true; return socket as any; } });
        socket.addEventListener("message", (ev) => { this.stats.bytes += (ev.data as ArrayBuffer).byteLength ?? 0; });
        socket.addEventListener("close", () => { if (!this.stopped) { this.stats.state = "stopped"; this.stats.error = "connection closed by the relay"; this.emit(); } });

        this.stats.state = "handshake"; this.emit();
        const accepted = await new HandshakeClient(this.mux).propose({ networkMagic, query: false });
        if (!(accepted instanceof HandshakeAcceptVersion)) throw new Error("handshake refused: " + JSON.stringify(accepted));
        this.stats.version = Number((accepted as any).versionNumber ?? 0);
        this.log(`handshake accepted, N2N version ${this.stats.version}`);
        this.lq = new LightQueryClient(this.mux);
        this.stats.lightQuery = await this.lq.supported;
        this.log(this.stats.lightQuery ? "relay speaks the Gerolamo light-query protocol (nonce + stake over the WebSocket)" : "relay has no light-query protocol; header crypto needs the HTTP API fallback");
        const keepAlive = new KeepAliveClient(this.mux);
        const ka = setInterval(() => { keepAlive.request((Date.now() / 1000) & 0xffff).catch(() => {}); }, 20_000);

        const cs = new ChainSyncClient(this.mux);
        const bf = new BlockFetchClient(this.mux);
        try {
            // 1. learn the relay's tip
            const probe = await cs.findIntersect([ChainPoint.origin]);
            const tipOf = (m: any) => m.tip ? { slot: Number(m.tip.point.blockHeader?.slotNumber ?? 0), blockNo: Number(m.tip.blockNo), hash: m.tip.point.blockHeader ? hex(m.tip.point.blockHeader.hash) : "" } : null;
            this.stats.serverTip = tipOf(probe);
            // 2. choose where to start (a persistent store resumes at its last verified block)
            let start: "tip" | "origin" | { slot: number; hash: string } = this.opts.start === "mithril" ? "tip" : (this.opts.start ?? "tip");
            if (this.opts.start === "mithril") {
                const net = networkByMagic(this.opts.networkMagic);
                if (!net) throw new Error("unknown network magic for the Mithril anchor");
                if (!this.lq || !this.stats.lightQuery) throw new Error("the Mithril anchor needs the relay's light-query protocol (GetChunk)");
                this.stats.state = "handshake"; this.emit();
                const a = await mithrilAnchor({ network: net.name, lq: this.lq, log: (l) => this.log(l) });
                this.stats.anchor = a;
                start = { slot: a.slot, hash: a.hash };
            }
            if (this.opts.storeSink) {
                this.writer = new ChunkWriter(this.opts.storeSink, this.opts.chunkSlots ?? 4320);
                const resumed = await this.writer.resume();
                if (resumed && start === "tip") {
                    const stored = await this.opts.storeSink.read(chunkFileNameFor(resumed.chunkNo, "secondary"));
                    const hashHex = stored ? lastEntryHash(stored) : null;
                    if (hashHex) { start = { slot: resumed.lastSlot, hash: hashHex }; this.stats.resumedFrom = resumed.lastSlot; this.log(`resuming from the stored block at slot ${resumed.lastSlot}`); }
                }
                const st = this.writer.stats; this.stats.storedBlocks = st.blocks; this.stats.storedBytes = st.bytes; this.stats.storedChunks = st.chunks;
            }
            let points: ChainPoint[];
            if (start === "origin") points = [ChainPoint.origin];
            else if (start === "tip") points = this.stats.serverTip?.hash ? [new ChainPoint({ blockHeader: { slotNumber: BigInt(this.stats.serverTip.slot), hash: fromHexStr(this.stats.serverTip.hash) } })] : [ChainPoint.origin];
            else points = [new ChainPoint({ blockHeader: { slotNumber: BigInt(start.slot), hash: fromHexStr(start.hash) } })];
            const isect = await cs.findIntersect(points);
            if (isect instanceof ChainSyncIntersectNotFound) throw new Error("intersect not found");
            const found = isect as ChainSyncIntersectFound;
            this.stats.intersect = found.point.blockHeader ? `slot ${found.point.blockHeader.slotNumber}` : "origin";
            this.stats.serverTip = tipOf(found) ?? this.stats.serverTip;
            this.log(`intersect at ${this.stats.intersect}; relay tip slot ${this.stats.serverTip?.slot} height ${this.stats.serverTip?.blockNo}`);
            this.stats.state = "syncing"; this.emit();

            // 3. follow
            let expectPrev: string | null = start === "tip" ? this.stats.serverTip?.hash ?? null : start === "origin" ? null : start.hash;
            if (isect instanceof ChainSyncIntersectNotFound && start !== "tip" && start !== "origin") this.log("stored tip is not on the relay's chain; falling back to the relay tip");
            while (!this.stopped) {
                const msg: any = await cs.requestNext();
                if (msg instanceof ChainSyncRollBackwards) {
                    this.stats.rollbacks++;
                    const p = msg.point?.blockHeader;
                    expectPrev = p ? hex(p.hash) : null;
                    this.log(`RollBackward to ${p ? `slot ${p.slotNumber}` : "origin"}`);
                    this.stats.serverTip = tipOf(msg) ?? this.stats.serverTip;
                    this.emit();
                    continue;
                }
                if (!(msg instanceof ChainSyncRollForward)) { this.log(`unexpected ${msg?.constructor?.name}`); continue; }
                this.stats.serverTip = tipOf(msg) ?? this.stats.serverTip;
                let h: HeaderSummary;
                try { h = summarizeHeader(msg.data); } catch (e) { this.log(`header skipped: ${(e as Error).message}`); continue; }
                this.stats.headers++;
                if (expectPrev != null) { if (h.prevHash === expectPrev) this.stats.linkOk++; else { this.stats.linkBad++; this.log(`LINK MISMATCH at slot ${h.slot}: prev ${h.prevHash?.slice(0, 16)} ≠ ${expectPrev.slice(0, 16)}`); } }
                expectPrev = h.hash;
                // header cryptography: opcert, KES, VRF against η0
                const net = networkByMagic(this.opts.networkMagic);
                const nonce = net ? await this.epochNonce(epochOfSlot(net, h.slot)) : null;
                if (net && nonce) {
                    try {
                        const r = verifyHeaderCrypto(parseHeaderCrypto(h.headerBytes, h.eraTag), nonce, net.slotsPerKESPeriod, net.maxKESEvolutions);
                        if (r.opcertOk && r.kesOk && r.vrfOk) this.stats.cryptoOk++; else { this.stats.cryptoBad++; this.log(`HEADER CRYPTO FAILED at slot ${h.slot}: ${r.detail.join("; ")}`); }
                        // leader eligibility: σ = pool stake / total from the relay (light query), leader value vs. the Praos threshold
                        if (this.lq && this.stats.lightQuery) {
                            const hc = parseHeaderCrypto(h.headerBytes, h.eraTag);
                            const poolId = new Uint8Array(blake2b_224(hc.issuerVkey));
                            const epoch = epochOfSlot(net, h.slot);
                            const key = `${epoch}:${hex(poolId)}`;
                            let st = this.stakeCache.get(key);
                            if (!st) { st = await this.lq.poolStake(epoch, poolId); this.stakeCache.set(key, st); if (this.stakeCache.size > 2000) this.stakeCache.clear(); }
                            if (st.poolStake != null && st.totalActiveStake) {
                                const leaderValue = hc.vrf ? new Uint8Array(blake2b_256(concatBytes(new TextEncoder().encode("L"), hc.vrf.output))) : hc.leaderVrf!.output;
                                const leads = isSlotLeader(leaderValue, { num: st.poolStake, den: st.totalActiveStake }, Number(st.activeSlotsCoeff.num) / Number(st.activeSlotsCoeff.den));
                                if (leads) this.stats.leaderOk++; else { this.stats.leaderBad++; this.log(`LEADER CHECK FAILED at slot ${h.slot}: pool ${hex(poolId).slice(0, 12)}… stake ${st.poolStake}/${st.totalActiveStake}`); }
                            } else this.stats.leaderSkipped++;
                        } else this.stats.leaderSkipped++;
                    } catch (e) { this.stats.cryptoBad++; this.log(`header crypto threw at slot ${h.slot}: ${(e as Error).message}`); }
                } else this.stats.cryptoSkipped++;
                this.stats.lastSlot = h.slot; this.stats.lastBlockNo = h.blockNo; this.stats.lastHash = h.hash;
                if (this.opts.fetchBodies !== false) {
                    const pt = new ChainPoint({ blockHeader: { slotNumber: BigInt(h.slot), hash: fromHexStr(h.hash) } });
                    const blocks = await bf.requestRange(pt, pt);
                    const b = Array.isArray(blocks) ? blocks[0] : null;
                    if (b) {
                        this.stats.blocksFetched++;
                        const bytes: Uint8Array = b.blockData;
                        const got = bodyHashOf(bytes);
                        if (got.hash === h.bodyHash && bytes.length - (bytes.length - h.bodySize) >= 0) this.stats.bodyOk++; else { this.stats.bodyBad++; this.log(`BODY HASH MISMATCH at slot ${h.slot}`); }
                        this.recent.push({ slot: h.slot, blockNo: h.blockNo, hash: h.hash, bytes, txs: got.txs });
                        if (this.writer && got.hash === h.bodyHash) {
                            try { await this.writer.append(h.slot, fromHexStr(h.hash), bytes); const st = this.writer.stats; this.stats.storedBlocks = st.blocks; this.stats.storedBytes = st.bytes; this.stats.storedChunks = st.chunks; }
                            catch (e) { this.log(`store: ${(e as Error).message}`); }
                        }
                        while (this.recent.length > (this.opts.keep ?? 64)) this.recent.shift();
                    }
                }
                this.stats.state = this.stats.serverTip && h.slot >= this.stats.serverTip.slot ? "at-tip" : "syncing";
                this.emit();
            }
        } catch (err) {
            this.stats.state = "error"; this.stats.error = (err as Error).message; this.emit();
            this.log(`error: ${(err as Error).message}`);
        } finally {
            clearInterval(ka);
        }
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.stats.state = "stopped";
        try { this.mux?.close({ closeSocket: true }); } catch { /* ignore */ }
        this.emit();
    }
}
