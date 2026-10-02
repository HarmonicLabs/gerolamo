import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockFetchBlock, type ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { initSql } from "../sql";
import { ensureInitialized, setStrictUtxoApply } from "../db";
import { BlockStore } from "../storage/blockStore";
import { configureBlockStoreMode, setNodeBlockStore } from "../storage/nodeBlockStore";
import { getSelectedTipHash, setSelectedTipHash } from "../storage/blockReads";
import { configureLedgerStore, getLedgerStore, ledgerBeginBlock, ledgerCommitBlock, ledgerStoreBroken, openNodeLedgerStore } from "../ledger/nodeLedgerStore";
import { setEpochNetwork } from "../utils/epochFromSlotCalculations";
import { forgeBlock, type ForgedBlock } from "../pool/forge";
import { compareBytes } from "./tieBreak";
import { issueOperationalCert, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey } from "../pool/keystore";
import { ConsensusOrchestrator } from "./ConsensusOrchestratooor";
import type { HeaderSummary } from "./blockHeaderParser";

/**
 * Bug 284 (producer, 2026-09-29 10:03:57 UTC, halted 8 h 40 min), replayed through the real
 * orchestrator, block store (primary mode) and LMDB ledger store with forged (empty, correctly
 * signed) Babbage blocks:
 *
 *   P ─ W1 … A ─┬─ L   (the old primary's tip; the new primary held it too, for 0.2 s)
 *               └─ N ─ N2   (the network's chain: N won the slot battle on the lower VRF)
 *
 * The outvote switch submits the new primary's fragment (W1 … A, L); its RollBackward to A and its
 * header N follow; N does not chain onto our tip (P), so its ChainSync restarts and re-streams
 * W1 … A, N, N2 while the switch's ranges are still downloading. The switch's ranges apply (tip L),
 * the re-streamed ranges W1 … A are all duplicates — and the block store's selected tip used to be
 * set to the last point of each such range (A) although L was applied on top of it: N then passed
 * the block store's continuity check and hit the LMDB store, whose tip was still L → "ledger store
 * unusable" → SYNC HALTED.
 */

const F = (n: string) => new URL(`../pool/__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const SLOTS_PER_KES = 129600n;
const S0 = 124_017_567n; // the incident's last common block P (7f28434e…), preview epoch 1435
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const dir = mkdtempSync(join(tmpdir(), "gerolamo-legacy-fork-"));
const keys = (() => {
    const cold = loadColdSigningKey(F("cold.skey"));
    const kes = loadKesSigningKey(F("kes.skey"), F("kes.vkey"));
    const vrf = loadVrfSigningKey(F("vrf.skey"), F("vrf.vkey"));
    const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, S0 / SLOTS_PER_KES - 2n, cold);
    return { cold, kes, vrf, opcert: opcert.cert };
})();

interface Blk { slot: bigint; hash: string; prev: string; no: bigint; forged: ForgedBlock }
function forge(parent: { hash: string; no: bigint }, slot: bigint, nonceByte = 0x11): Blk {
    const f = forgeBlock({
        era: 6, blockNumber: parent.no + 1n, slot, prevHash: Uint8Array.from(Buffer.from(parent.hash, "hex")),
        nonce: new Uint8Array(32).fill(nonceByte), coldVkey: keys.cold.vkey, vrf: keys.vrf, kes: keys.kes, opcert: keys.opcert,
        protocolVersion: { major: 9, minor: 0 }, slotsPerKESPeriod: SLOTS_PER_KES,
    });
    return { slot, hash: hex(f.headerHash), prev: parent.hash, no: parent.no + 1n, forged: f };
}

/** A hot peer: serves bodies of the blocks it knows, optionally held behind a gate. */
class FakePeer {
    chainSyncGeneration = 1;
    chainSyncInFlight = 0;
    isTerminated = false;
    readonly source = "ledger";
    readonly chainSyncAtTip = true;
    readonly restarts: string[] = [];
    gate: Promise<void> | null = null;
    constructor(readonly peerKey: string, private readonly blocks: Map<string, Blk>) {}
    get peerId(): string { return `${this.peerKey}:1`; }
    async restartChainSync(reason: string): Promise<void> { this.restarts.push(reason); this.chainSyncGeneration++; }
    terminate(_why: string): void { this.isTerminated = true; }
    async fetchBlockRange(points: ChainPoint[]): Promise<BlockFetchBlock[]> {
        if (this.gate) await this.gate;
        return points.map((p) => {
            const b = this.blocks.get(hex(p.blockHeader!.hash));
            if (!b) throw new Error(`no block ${hex(p.blockHeader!.hash)}`);
            return new BlockFetchBlock({ blockData: b.forged.blockFetchBytes });
        });
    }
}

const summary = (b: Blk): HeaderSummary => ({
    slot: b.slot, blockHeaderHash: b.forged.headerHash, era: 6, epoch: 1435, isByron: false, isEbb: false,
    rawHeaderBytes: b.forged.headerBytes, prevHashHex: b.prev,
});
const item = (b: Blk, tip: bigint) => ({ rollForwardCborBytes: b.forged.rollForwardData, tip });

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 10));
    }
}

let orch: ConsensusOrchestrator;
let blocks = new Map<string, Blk>();
let P: Blk, W: Blk[], A: Blk, L: Blk, N: Blk, N2: Blk;
let peers = new Map<string, FakePeer>();
const KEYS = ["76.156.32.49:5001", "127.0.0.1:6424", "77.23.179.21:4444"];

/**
 * A fresh node (SQLite, primary block store, LMDB ledger store) whose chain ends at P, and the fork
 * P ─ W1 … A ─ {L, N ─ N2}; L and N share slot and issuer, so the VRF output decides between them.
 * `nWins`: N carries the lower VRF output (the incident: the relay switched to N for its lower VRF).
 */
async function scenario(name: string, nWins: boolean): Promise<void> {
    await orch?.stop().catch(() => undefined);
    getLedgerStore()?.close();
    const sub = join(dir, name);
    const dbPath = join(sub, "preview.db");
    initSql(dbPath);
    await ensureInitialized();
    configureBlockStoreMode("primary");
    const bs = await BlockStore.open(join(sub, "db"), { k: 432 });
    setNodeBlockStore(bs);

    blocks = new Map();
    P = forge({ hash: "ab".repeat(32), no: 4_707_853n }, S0);
    W = [];
    let parent: Blk = P;
    for (let i = 0; i < 6; i++) { parent = forge(parent, parent.slot + 9n + BigInt(i)); W.push(parent); }
    A = W[W.length - 1]!;
    L = forge(A, A.slot + 51n, 0x22); // same slot, same pool, another VRF input: a competing block
    for (let nonce = 0x23; ; nonce++) { // the VRF output (lower wins) decides the battle
        N = forge(A, A.slot + 51n, nonce);
        if ((compareBytes(N.forged.vrf.output, L.forged.vrf.output) < 0) === nWins) break;
    }
    N2 = forge(N, N.slot + 5n);
    for (const b of [P, ...W, L, N, N2]) blocks.set(b.hash, b);

    // our chain: P is applied (block store tip, LMDB anchor)
    await bs.put(P.forged.blockFetchBytes, P.forged.headerHash);
    setSelectedTipHash(P.forged.headerHash);
    configureLedgerStore("lmdb");
    await openNodeLedgerStore({ dbPath, ledgerStore: "lmdb" }, { slot: Number(P.slot), hash: P.forged.headerHash });

    peers = new Map(KEYS.map((k) => [k, new FakePeer(k, blocks)]));
    orch = new ConsensusOrchestrator({
        networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", syncFromGenesis: true,
        dbPath, sync: { quorum: 2 }, validation: { workers: 0 }, blockFetchBatch: { maxRangeBlocks: 16 },
    } as never, {
        getPeer: (id: string) => peers.get(id) ?? [...peers.values()].find((p) => p.peerId === id) ?? null,
        pickHotPeer: () => null,
    } as never);
    orch.attachBlockStore(bs);
    const o = orch as any;
    o.kCached = 432;
    o.getEpochNonce = async () => null; // no nonce evolution in this replay (empty blocks, one epoch)
}

/** The incident's sequence from the outvote switch at 10:03:57 to the re-streamed ranges (`withN2`: N2 is already announced). */
async function replayIncident(withN2 = true): Promise<FakePeer> {
    const o = orch as any;
    const [old, relay, v2] = KEYS.map((k) => peers.get(k)!);
    for (const p of [old!, relay!, v2!]) orch.registerHotPeer(p.peerKey);
    expect(orch.primaryPeerKey()).toBe(old!.peerKey);
    // fragments as they stood at 10:03:57: the old primary and the relay on …A, L; the third peer on …A, N
    for (const b of [P, ...W, L]) orch.candidates.observe(old!.peerKey, { slot: b.slot, hash: b.hash });
    for (const b of [...W, L]) orch.candidates.observe(relay!.peerKey, { slot: b.slot, hash: b.hash });
    for (const b of [...W, N]) orch.candidates.observe(v2!.peerKey, { slot: b.slot, hash: b.hash });

    relay!.gate = new Promise<void>((r) => { (relay as any).open = r; });
    v2!.gate = relay!.gate; old!.gate = relay!.gate;
    // the outvote switch (the verifiers' recorded divergence: W1's slot) submits the relay's fragment
    await o.switchPrimaryAfterOutvote(W[0]!.slot, W[0]!.hash, [relay!.peerKey, v2!.peerKey]);
    expect(orch.primaryPeerKey()).toBe(relay!.peerKey);
    // the relay switches to N (lower VRF): RollBackward to A, then N — which does not chain onto our tip P
    await orch.handleRollBack({ blockHeader: { slotNumber: A.slot, hash: A.forged.headerHash } } as never, undefined, relay!.peerId);
    await o.acceptPrimaryHeaders(relay, [item(N, N2.slot)], [summary(N)], [""]);
    expect(relay!.restarts.length).toBe(1);
    // the restarted stream re-sends W1 … A, N, N2 from our tip while the switch's ranges still download
    const restream = withN2 ? [...W, N, N2] : [...W, N];
    await o.acceptPrimaryHeaders(relay, restream.map((b) => item(b, N2.slot)), restream.map(summary), restream.map(() => ""));
    (relay as any).open();
    return relay!;
}

beforeAll(() => { setEpochNetwork("preview"); });

afterAll(async () => {
    await orch?.stop().catch(() => undefined);
    setStrictUtxoApply(false); // the orchestrator sets this process-wide
    getLedgerStore()?.close();
    configureLedgerStore("sqlite");
    setNodeBlockStore(null);
    rmSync(dir, { recursive: true, force: true });
});

describe("legacy chain following: a primary switch onto a branch that loses a slot battle 0.2 s later (bug 284)", () => {
    test("the node rolls the losing block back and follows the network instead of halting", async () => {
        await scenario("n-wins", true);
        const o = orch as any;
        await replayIncident();
        await until(() => o.halted != null || (!!getSelectedTipHash() && hex(getSelectedTipHash()!) === N2.hash));
        expect(o.halted).toBeNull();
        expect(ledgerStoreBroken()).toBeNull();
        expect(hex(getSelectedTipHash()!)).toBe(N2.hash);
        expect(hex(getLedgerStore()!.selectedTip()!)).toBe(N2.hash); // the ledger store follows the same chain
        expect(o.recentlyRolledBack.has(L.hash)).toBe(true); // L was applied, then rolled back (as the relay itself did)
    }, 60_000);

    test("a block that does not extend the ledger store's tip but a block it holds below it: the store rolls back to that block (no halt)", () => {
        // the orchestrator keeps the two stores together; this is the store's own guard should they ever part
        const st = getLedgerStore()!;
        expect(hex(st.selectedTip()!)).toBe(N2.hash);
        const X = forge(N, N2.slot, 0x44); // a competitor of N2
        ledgerBeginBlock(X.forged.headerHash, N.forged.headerHash, Number(X.slot));
        ledgerCommitBlock();
        expect(ledgerStoreBroken()).toBeNull();
        expect(hex(st.selectedTip()!)).toBe(X.hash);
        expect(st.hasDiff(N2.forged.headerHash)).toBe(false); // N2's diff went with the rollback
        expect(st.chainReachesAnchor(X.forged.headerHash)).toBe(true);
    });

    // The apply-time switch takes only a preferable branch (cardano-node's rule): longer, or as long and
    // preferred by the Praos tie-break. The branch's length counts the headers still waiting for bodies.
    for (const [name, nWins, withN2, expectTip] of [
        ["as long, the tie-break prefers it", true, false, "N"],
        ["as long, the tie-break prefers ours", false, false, "L"],
        ["longer, though the tie-break prefers ours", false, true, "N2"],
    ] as const) {
        test(`a branch ${name}: ${expectTip === "L" ? "kept ours (no rollback, no halt)" : `switched to ${expectTip}`}`, async () => {
            await scenario(`${nWins}-${withN2}`, nWins);
            const o = orch as any;
            const relay = await replayIncident(withN2);
            const want = expectTip === "L" ? L : expectTip === "N" ? N : N2;
            await until(() => o.halted != null || relay.isTerminated || (!!getSelectedTipHash() && hex(getSelectedTipHash()!) === want.hash));
            await new Promise((r) => setTimeout(r, 50));
            expect(o.halted).toBeNull();
            expect(ledgerStoreBroken()).toBeNull();
            expect(hex(getSelectedTipHash()!)).toBe(want.hash);
            expect(hex(getLedgerStore()!.selectedTip()!)).toBe(want.hash);
            expect(o.recentlyRolledBack.has(L.hash)).toBe(expectTip !== "L");
            if (expectTip === "L") expect(relay.isTerminated).toBe(true); // N's range failed the continuity check: the pipeline restarts
        }, 60_000);
    }
});
