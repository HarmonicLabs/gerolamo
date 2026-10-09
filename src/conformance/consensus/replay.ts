/**
 * Replays the ouroboros-mock consensus scenarios (blinklabs-io/ouroboros-mock `consensus/`, captured
 * from cardano-node peers) against Gerolamo's Praos chain selection and its N2N ChainSync server.
 *
 * A vector holds each upstream peer's served ChainSync trace (RollBackward / RollForward with the
 * raw header) and the oracle's outcome: the final tip, the rollback point of the fork switch (when
 * there is one), and the ChainSync messages a downstream client is served. The replay drives what
 * the node runs in `consensus.chainSelection: "praos"`:
 *
 *   - every RollForward goes through `headerParser` (the ChainSync header decoder) into
 *     `ChainSelDriver.observe` (ConsensusOrchestratooor: after header validation); a RollBackward
 *     into `ChainSelDriver.rollBackward`;
 *   - when a peer's stream reaches the tip it announced (MsgAwaitReply), the orchestrator's
 *     `evaluateChainSel` step runs: `ChainSelDriver.decide`, then "extend" / "switch" adopt the
 *     candidate (headers only: the replay has no bodies, as in Dingo's replay), punished peers are
 *     dropped. A switch is recorded with our tip before it and the candidate's intersection;
 *   - the downstream side serves the selected chain from a `BlockStore` (header-only blocks) through
 *     `ChunkRelayChainStore` and `N2NChainSyncHost` to a client that intersects where the selected
 *     peer's trace starts and reads until MsgAwaitReply.
 *
 * Not exercised: header crypto (KES, VRF, operational certificates): the captures' genesis and stake
 * distribution are not part of the vectors.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbor, CborArray, CborBytes, CborSimple, CborTag, CborUInt } from "@harmoniclabs/cbor";
import {
    ChainPoint, ChainSyncAwaitReply, ChainSyncFindIntersect, ChainSyncIntersectFound, ChainSyncRequestNext, ChainSyncRollBackwards, ChainSyncRollForward,
    MiniProtocol, chainSyncMessageFromCborObj, type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { headerParser } from "../../consensus/blockHeaderParser";
import { ChainSelDriver, type OurBlock } from "../../consensus/chainsel/ChainSelDriver";
import type { Candidate, IncomingHeader } from "../../consensus/chainsel/ChainSel";
import { BlockStore } from "../../storage/blockStore";
import { ChunkRelayChainStore } from "../../network/n2n/ChunkRelayChainStore";
import { N2NChainSyncHost } from "../../network/n2n/N2NChainSyncHost";

// ───────────────────────────── vector format (consensus/format/vector.go) ─────────────────────────────

export interface Point { slot: number; hash: string }
export interface Tip { slot: number; hash: string; block_number: number }
export interface Served { protocol: string; msg_type: string; era?: number; header_cbor?: string; tip?: Tip; point?: Point }
export interface ConsensusVector {
    schema_version: number;
    title: string;
    category: string;
    capture: {
        peers: Array<{ peer_id: number; served: Served[] }>;
        expected_output: { downstream_chainsync: Served[]; final_tip: Tip; expected_rollback?: { point: Point; tip: Tip } };
        security_param?: number;
        local_tip?: Tip;
    };
}
export interface SwitchEvent { previousTip: Tip; newTip: Tip; rollbackPoint: Point | null }

/** k when a vector predates `security_param` (zero = k-bounded rollback disabled): cardano-node mainnet's. */
const UNBOUNDED_K = 2160;

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** The ChainSync MsgRollForward a peer sent: `[2, [era − 1, #6.24(header)], [[slot, hash], blockNo]]`. */
function rollForwardMessage(era: number, header: Uint8Array, tip: Tip): Uint8Array {
    const point = tip.hash ? new CborArray([new CborUInt(BigInt(tip.slot)), new CborBytes(hexBytes(tip.hash))]) : new CborArray([]);
    return Cbor.encode(new CborArray([
        new CborUInt(2n),
        new CborArray([new CborUInt(BigInt(era - 1)), new CborTag(24, new CborBytes(header))]),
        new CborArray([point, new CborUInt(BigInt(tip.block_number))]),
    ])).toBuffer();
}

/** Block number and slot from a Shelley-era header `[[block_no, slot, …], sig]`. */
function headerNumbers(header: Uint8Array): { blockNo: number; slot: number } {
    const h = Cbor.parse(header) as CborArray;
    const body = h.array[0] as CborArray;
    return { blockNo: Number((body.array[0] as CborUInt).num), slot: Number((body.array[1] as CborUInt).num) };
}

interface KnownHeader { hash: string; prevHash: string | null; slot: bigint; blockNo: number; hfcEra: number; era: number; raw: Uint8Array }

export class ConsensusReplay {
    readonly k: number;
    private readonly driver: ChainSelDriver;
    private readonly known = new Map<string, KnownHeader>();
    /** Our selected chain, oldest first (an anchor stand-in first when the replay starts above origin). */
    private chain: KnownHeader[] = [];
    /** The peer whose candidate we last adopted (the orchestrator's primary). */
    primary: string | null = null;
    private readonly peers = new Set<string>();
    readonly switches: SwitchEvent[] = [];
    readonly punished: Array<{ peer: string; why: string }> = [];
    headersFed = 0;
    decisions = 0;

    constructor(readonly vector: ConsensusVector) {
        this.k = vector.capture.security_param || UNBOUNDED_K;
        this.driver = new ChainSelDriver("praos", {
            k: this.k,
            tip: async () => {
                const t = this.chain[this.chain.length - 1];
                return t ? { hash: t.hash, slot: t.slot, blockNo: BigInt(t.blockNo), hfcEra: t.hfcEra, raw: t.raw.length ? t.raw : null } : null;
            },
            block: async (hash): Promise<OurBlock | null> => {
                const b = this.chain.find((x) => x.hash === hash.toLowerCase());
                return b ? { hash: b.hash, prevHash: b.prevHash, slot: b.slot, hfcEra: b.hfcEra, raw: b.raw.length ? b.raw : null } : null;
            },
            isOurs: async (hash) => this.chain.some((x) => x.hash === hash.toLowerCase()),
            isIdle: () => true,
            isLocalRoot: () => false,
            slotAgeMs: () => 0,
            genesisWindow: () => 0n,
        });
    }

    private tipOf(h: KnownHeader): Tip { return { slot: Number(h.slot), hash: h.hash, block_number: h.blockNo }; }
    ourTip(): Tip | null { const t = this.chain[this.chain.length - 1]; return t && t.raw.length ? this.tipOf(t) : null; }
    selectedChain(): readonly KnownHeader[] { return this.chain; }

    /**
     * A trace that opens with a RollBackward to a block above origin: the node intersected there, so
     * it holds that block. With nothing selected yet, a stand-in for it (that slot and hash, the block
     * number below the first header) becomes our chain's anchor.
     */
    private anchorAt(point: Point, firstHeader: Uint8Array | null): void {
        if (this.chain.length || !point.hash) return;
        const blockNo = firstHeader ? headerNumbers(firstHeader).blockNo - 1 : 0;
        const h: KnownHeader = { hash: point.hash, prevHash: null, slot: BigInt(point.slot), blockNo, hfcEra: 6, era: 7, raw: new Uint8Array() };
        this.known.set(h.hash, h);
        this.chain = [h];
    }

    async rollBackward(peer: string, point: Point, firstHeader: Uint8Array | null): Promise<void> {
        this.anchorAt(point, firstHeader);
        await this.driver.syncOurs();
        if (!this.peers.has(peer)) { this.peers.add(peer); this.driver.addPeer(peer); }
        this.driver.rollBackward(peer, { hash: point.hash || null, slot: BigInt(point.slot) });
    }

    async rollForward(peer: string, era: number, header: Uint8Array, tip: Tip): Promise<void> {
        const parsed = await headerParser(rollForwardMessage(era, header, tip));
        if (!parsed) throw new Error(`header of era ${era} does not parse`);
        const hash = toHex(parsed.blockHeaderHash);
        const h: KnownHeader = { hash, prevHash: parsed.prevHashHex, slot: parsed.slot, blockNo: headerNumbers(parsed.rawHeaderBytes).blockNo, hfcEra: parsed.isByron ? 0 : Math.max(1, parsed.era - 1), era: parsed.era, raw: parsed.rawHeaderBytes };
        this.known.set(hash, h);
        await this.driver.syncOurs();
        if (!this.peers.has(peer)) { this.peers.add(peer); this.driver.addPeer(peer); }
        const incoming: IncomingHeader = { hash, prevHash: h.prevHash, slot: h.slot, hfcEra: h.hfcEra, isEbb: parsed.isEbb, raw: h.raw };
        await this.driver.observe(peer, [incoming]);
        this.headersFed++;
    }

    /** The orchestrator's `evaluateChainSel` until the selection is settled. */
    async evaluate(): Promise<void> {
        for (let guard = 0; guard < 64; guard++) {
            const v = await this.driver.decide(this.primary, [...this.peers]);
            this.decisions++;
            for (const p of v.punish) { this.punished.push({ peer: p.peer, why: p.why }); this.driver.removePeer(p.peer); this.peers.delete(p.peer); }
            const d = v.decision;
            if (d.kind === "keep") return;
            this.adopt(d.candidate, d.kind === "switch");
        }
        throw new Error("chain selection did not settle");
    }

    private adopt(c: Candidate, isSwitch: boolean): void {
        const before = this.ourTip();
        const at = this.chain.findIndex((x) => x.hash === c.intersection.hash);
        if (at < 0 && c.intersection.hash !== "00".repeat(32)) throw new Error(`candidate intersection ${c.intersection.hash.slice(0, 12)}… is not on our chain`);
        const suffix = c.suffix.map((s) => { const k = this.known.get(s.hash); if (!k) throw new Error(`unknown header ${s.hash}`); return k; });
        this.chain = [...this.chain.slice(0, at + 1), ...suffix];
        this.primary = c.peer;
        if (isSwitch && before) {
            const ip = this.known.get(c.intersection.hash);
            this.switches.push({ previousTip: before, newTip: this.ourTip()!, rollbackPoint: ip ? { slot: Number(ip.slot), hash: ip.hash } : { slot: 0, hash: "" } });
        }
    }

    /**
     * What a downstream client is served: the selected chain as header-only blocks (`[era, [header]]`,
     * all a node-to-node RollForward carries) in a scratch `BlockStore`, served by `N2NChainSyncHost`
     * over `ChunkRelayChainStore` to a client intersecting at `intersect`, up to MsgAwaitReply.
     */
    async downstream(intersect: Point): Promise<Served[]> {
        const dir = await mkdtemp(join(tmpdir(), "gerolamo-conformance-"));
        const mux = new FakeMux();
        let host: N2NChainSyncHost | null = null;
        try {
            const store = await BlockStore.open(dir, { k: this.k });
            for (const h of this.chain) {
                if (!h.raw.length) { await store.put(standInBlock(h, this.chain[1]), hexBytes(h.hash)); continue; }
                await store.put(Cbor.encode(new CborArray([new CborUInt(BigInt(h.era)), new CborArray([Cbor.parse(h.raw)])])).toBuffer(), hexBytes(h.hash));
            }
            const relay = new ChunkRelayChainStore(store);
            const tip = this.chain[this.chain.length - 1];
            if (tip) relay.setTip(tip.hash);
            host = new N2NChainSyncHost(mux as unknown as Multiplexer, relay, { pollIntervalMs: 60_000 });
            const send = async (m: { toCborBytes(): Uint8Array }) => { mux.emit(MiniProtocol.ChainSync as any, m.toCborBytes()); for (let i = 0; i < 50 && mux.idle(); i++) await Bun.sleep(0); };
            const ip = intersect.hash ? new ChainPoint({ blockHeader: { slotNumber: BigInt(intersect.slot), hash: hexBytes(intersect.hash) } }) : ChainPoint.origin;
            await send(new ChainSyncFindIntersect({ points: [ip] }));
            const found = mux.take();
            if (!(found instanceof ChainSyncIntersectFound)) throw new Error(`downstream: no intersection (${found?.constructor?.name})`);
            const out: Served[] = [];
            for (let i = 0; i < 100_000; i++) {
                await send(new ChainSyncRequestNext());
                const m = mux.take();
                if (m instanceof ChainSyncAwaitReply) return out;
                if (m instanceof ChainSyncRollForward) {
                    const data = m.data as CborArray;
                    const era = Number((data.array[0] as CborUInt).num) + 1;
                    const header = ((data.array[1] as CborTag).data as CborBytes).bytes;
                    out.push({ protocol: "chainsync", msg_type: "roll_forward", era, header_cbor: toHex(header), tip: tipOfWire(m.tip) });
                } else if (m instanceof ChainSyncRollBackwards) {
                    out.push({ protocol: "chainsync", msg_type: "roll_backward", point: pointOfWire(m.point), tip: tipOfWire(m.tip) });
                } else throw new Error(`downstream: unexpected ${m?.constructor?.name}`);
            }
            throw new Error("downstream: no MsgAwaitReply");
        } finally {
            host?.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    }
}

/**
 * A header-only block standing for the anchor block (never served: the client intersects at it):
 * the next header's bytes with the anchor's block number and slot and no parent. The store is given
 * the anchor's hash.
 */
function standInBlock(anchor: KnownHeader, next: KnownHeader | undefined): Uint8Array {
    if (!next) throw new Error("stand-in anchor without a following header");
    const h = Cbor.parse(next.raw) as CborArray;
    const body = h.array[0] as CborArray;
    body.array[0] = new CborUInt(BigInt(anchor.blockNo));
    body.array[1] = new CborUInt(anchor.slot);
    body.array[2] = new CborSimple(null);
    return Cbor.encode(new CborArray([new CborUInt(BigInt(next.era)), new CborArray([h])])).toBuffer();
}

function pointOfWire(p: ChainPoint): Point {
    const b = p.blockHeader;
    return b ? { slot: Number(b.slotNumber), hash: toHex(b.hash) } : { slot: 0, hash: "" };
}
function tipOfWire(t: any): Tip { const p = pointOfWire(t.point); return { slot: p.slot, hash: p.hash, block_number: Number(t.blockNo) }; }

class FakeMux extends EventEmitter {
    private sent: Uint8Array[] = [];
    send(payload: Uint8Array): void { this.sent.push(payload); }
    /** Nothing sent back yet. */
    idle(): boolean { return this.sent.length === 0; }
    take(): any {
        const b = this.sent.shift();
        return b ? chainSyncMessageFromCborObj(Cbor.parse(b)) : null;
    }
}

// ───────────────────────────── the harness (consensus/harness.go) ─────────────────────────────

const tipsEqual = (a: Tip | null | undefined, b: Tip | null | undefined) => !!a && !!b && a.slot === b.slot && a.hash === b.hash && a.block_number === b.block_number;
const pointsEqual = (a: Point | undefined, b: Point | undefined) => (!a || !b ? a === b : a.slot === b.slot && a.hash === b.hash);

function lastRollForwardTip(served: Served[]): Tip | null {
    for (let i = served.length - 1; i >= 0; i--) if (served[i]!.msg_type === "roll_forward") return served[i]!.tip ?? null;
    return null;
}

export interface ReplayResult {
    /** Divergences from the oracle, as ouroboros-mock's harness checks them. */
    errors: string[];
    /**
     * Set when the oracle's final tip is a block no peer served a header for: the capture stopped
     * before it (the oracle node already held it). A node that selects among the headers it received
     * cannot end there; `tipAgnosticErrors` then repeats the checks with our tip expected at the
     * selected peer's last header and the downstream messages compared without their tip field.
     */
    unservedFinalTip: string | null;
    tipAgnosticErrors: string[];
    replay: ConsensusReplay;
    downstream: Served[];
}

/**
 * Feed every peer's trace in order, settle, and check what ouroboros-mock's `RunConsensusVector`
 * checks: the final tip (slot, hash, block number); with an expected rollback, a switch onto the
 * final tip off a shorter-or-equal non-winning peer, at the expected rollback point; and the
 * downstream ChainSync messages, exactly.
 */
export async function runConsensusVector(v: ConsensusVector): Promise<ReplayResult> {
    const errors: string[] = [], tipAgnosticErrors: string[] = [];
    const r = new ConsensusReplay(v);
    const cap = v.capture;
    const servedHashes = new Set<string>();
    for (const peer of cap.peers) {
        const key = `peer-${peer.peer_id}`;
        const firstHeader = peer.served.find((m) => m.msg_type === "roll_forward")?.header_cbor;
        for (const m of peer.served) {
            if (m.msg_type === "roll_forward") { await r.rollForward(key, m.era!, hexBytes(m.header_cbor!), m.tip!); servedHashes.add(toHex(blake2b_256(hexBytes(m.header_cbor!)))); }
            else if (m.msg_type === "roll_backward") await r.rollBackward(key, m.point!, firstHeader ? hexBytes(firstHeader) : null);
        }
        await r.evaluate(); // the peer's stream reached its tip (MsgAwaitReply)
    }
    await r.evaluate();
    const best = r.ourTip();
    const want = cap.expected_output.final_tip;
    const show = (t: Tip | null) => (t ? `${t.slot}/${t.hash.slice(0, 12)}…#${t.block_number}` : "none");
    if (!tipsEqual(best, want)) errors.push(`final_tip: got ${show(best)}, want ${show(want)}`);
    const er = cap.expected_output.expected_rollback;
    if (er) {
        const sw = r.switches.find((s) => tipsEqual(s.newTip, want) && cap.peers.some((p) => { const pt = lastRollForwardTip(p.served); return pt && tipsEqual(pt, s.previousTip) && !tipsEqual(pt, want) && pt.block_number <= want.block_number; }));
        if (!sw) errors.push(`switch decision: no switch onto the final tip off a shorter or equal-length peer (switches: ${r.switches.length})`);
        else if (!pointsEqual(sw.rollbackPoint ?? undefined, er.point)) errors.push(`rollback point: got ${sw.rollbackPoint?.slot}/${sw.rollbackPoint?.hash.slice(0, 12)}, want ${er.point.slot}/${er.point.hash.slice(0, 12)}`);
    }
    // the client intersects where the trace of the peer we follow starts
    const selected = cap.peers.find((p) => `peer-${p.peer_id}` === r.primary);
    const first = selected?.served[0];
    const intersect: Point = first?.msg_type === "roll_backward" && first.point ? first.point : { slot: 0, hash: "" };
    const got = await r.downstream(intersect);
    const exp = cap.expected_output.downstream_chainsync;
    const compare = (sink: string[], withTip: boolean) => {
        if (got.length !== exp.length) sink.push(`downstream ChainSync: got ${got.length} messages, want ${exp.length}`);
        for (let i = 0; i < Math.min(got.length, exp.length); i++) {
            const g = got[i]!, e = exp[i]!;
            const same = g.msg_type === e.msg_type && (g.era ?? null) === (e.era ?? null) && (g.header_cbor ?? "") === (e.header_cbor ?? "") && pointsEqual(g.point, e.point) && (!withTip || tipsEqual(g.tip, e.tip));
            if (!same) { sink.push(`downstream ChainSync message ${i}: got ${JSON.stringify({ ...g, header_cbor: g.header_cbor?.slice(0, 16) })}, want ${JSON.stringify({ ...e, header_cbor: e.header_cbor?.slice(0, 16) })}`); break; }
        }
    };
    compare(errors, true);
    const unservedFinalTip = servedHashes.has(want.hash) ? null : `final tip ${show(want)} was never served: the capture ends at ${show(selected ? lastServedHeaderTip(selected.served) : null)}`;
    if (unservedFinalTip) {
        const lastHeader = selected ? lastServedHeaderTip(selected.served) : null;
        if (!tipsEqual(best, lastHeader)) tipAgnosticErrors.push(`tip: got ${show(best)}, want the selected peer's last header ${show(lastHeader)}`);
        compare(tipAgnosticErrors, false);
    }
    return { errors, unservedFinalTip, tipAgnosticErrors, replay: r, downstream: got };
}

/** Tip of the last header a peer served (its slot, hash and block number). */
function lastServedHeaderTip(served: Served[]): Tip | null {
    for (let i = served.length - 1; i >= 0; i--) {
        const m = served[i]!;
        if (m.msg_type !== "roll_forward" || !m.header_cbor) continue;
        const h = hexBytes(m.header_cbor);
        const n = headerNumbers(h);
        return { slot: n.slot, hash: toHex(blake2b_256(h)), block_number: n.blockNo };
    }
    return null;
}
