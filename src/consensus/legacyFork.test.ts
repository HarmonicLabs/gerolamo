import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockFetchBlock, type ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { initSql, sql } from "../sql";
import { ensureInitialized, setStrictUtxoApply, txOutColumns } from "../db";
import { _resetEpochParamsCache, storeEpochParams } from "./epochParams";
import { addressBech32, baseAddressBytes, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, signTxBody, txId } from "../pool/operator";
import { assembleBody, splitTx } from "../pool/bodyAssembly";
import { BlockStore } from "../storage/blockStore";
import { configureBlockStoreMode, setNodeBlockStore } from "../storage/nodeBlockStore";
import { getSelectedTipHash, setSelectedTipHash } from "../storage/blockReads";
import { configureLedgerStore, getLedgerStore, ledgerBeginBlock, ledgerCommitBlock, ledgerStoreBroken, ledgerUtxoReads, openNodeLedgerStore } from "../ledger/nodeLedgerStore";
import { setEpochNetwork } from "../utils/epochFromSlotCalculations";
import { forgeBlock, type BodySegments, type ForgedBlock } from "../pool/forge";
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
function forge(parent: { hash: string; no: bigint }, slot: bigint, nonceByte = 0x11, body?: BodySegments): Blk {
    const f = forgeBlock({
        era: 6, blockNumber: parent.no + 1n, slot, prevHash: Uint8Array.from(Buffer.from(parent.hash, "hex")),
        nonce: new Uint8Array(32).fill(nonceByte), coldVkey: keys.cold.vkey, vrf: keys.vrf, kes: keys.kes, opcert: keys.opcert,
        protocolVersion: { major: 9, minor: 0 }, slotsPerKESPeriod: SLOTS_PER_KES, body,
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

/**
 * Bug 340 (producer, 2026-10-03 04:09:16 UTC, "spends 2 input(s) not in the UTxO set"): a same-slot
 * battle at the tip, both blocks carrying the same transactions.
 *
 *   P ─ C ─┬─ L   (the primary's block, applied first)
 *          └─ W   (the network's block: same slot, lower VRF; same transactions as L)
 *
 * The primary sends L, rolls back to C and sends W. L's range is still queued, so it applies; W's range
 * (downloaded by then) is the next one, and the rules-ahead window of L's last block ran into it: W's
 * rules were evaluated on a worker with L's overlay (L spent W's inputs) — "not in the UTxO set". The
 * fork rollback for W's range (bug 284) then rolled both stores back to C correctly, but kept the
 * pipeline, and with it W's verdict from the dropped branch: SYNC HALTED.
 */
const FEE = 200_000n;
const payKey = generateKeyPair(new Uint8Array(32).fill(9));
const payAddrBytes = baseAddressBytes(0, keyHash(payKey.vkey), keyHash(payKey.vkey));
const payAddr = addressBech32(payAddrBytes);
const PARAMS_RAW = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", max_block_header_size: "1100", key_deposit: "2000000", pool_deposit: "500000000",
    coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "9", protocol_minor_ver: "0",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000",
    min_fee_ref_script_cost_per_byte: 15,
};
interface Tx { id: string; bytes: Uint8Array }
function payTx(inputs: Array<{ id: string; ix: number }>, outputs: bigint[]): Tx {
    const body = encodeTxBody({ inputs: inputs.map((i) => ({ txHash: Uint8Array.from(Buffer.from(i.id, "hex")), index: i.ix })), outputs: outputs.map((l) => ({ address: payAddrBytes, lovelace: l })), fee: FEE, certificates: [] });
    return { id: hex(txId(body)), bytes: encodeSignedTx(body, signTxBody(body, [payKey])) };
}
const bodyOf = (txs: Tx[]): BodySegments => assembleBody(txs.map((t) => splitTx(Uint8Array.from(Buffer.from(t.id, "hex")), t.bytes)), 90_112).segments;

let C: Blk, Lt: Blk, Wt: Blk, T0: Tx, T1: Tx, T2: Tx;
const G = "11".repeat(32); // the funding outputs, in the ledger at P

async function txScenario(name: string, opts: { sqlWrites: boolean; praos: boolean }): Promise<void> {
    await orch?.stop().catch(() => undefined);
    getLedgerStore()?.close();
    configureLedgerStore("sqlite"); // params and funding rows go to SQLite first; the LMDB store is seeded from them
    if (opts.sqlWrites) delete process.env.GEROLAMO_LEDGER_SQL_WRITES; else process.env.GEROLAMO_LEDGER_SQL_WRITES = "0";
    const sub = join(dir, name);
    const dbPath = join(sub, "preview.db");
    initSql(dbPath);
    await ensureInitialized();
    _resetEpochParamsCache();
    await storeEpochParams(1435, { ...PARAMS_RAW, epoch: 1435 }, "test");
    for (const [ix, lovelace] of [[0, 100_000_000n], [1, 50_000_000n]] as const) {
        const json = JSON.stringify({ address: payAddr, amount: String(lovelace), assets: {} });
        const c = txOutColumns(json);
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key) VALUES (${`${G}:${ix}`}, ${json}, ${G}, ${c.address}, ${c.lovelace}, ${c.referenceScriptHash}, ${c.stakeKey})`;
    }
    configureBlockStoreMode("primary");
    const bs = await BlockStore.open(join(sub, "db"), { k: 432 });
    setNodeBlockStore(bs);

    // C creates the outputs L and W both spend (the incident: 0a48251e…:1 and 50d7a11f…:0 came from de0a6a0a)
    T0 = payTx([{ id: G, ix: 0 }], [60_000_000n, 40_000_000n - FEE]);
    T1 = payTx([{ id: T0.id, ix: 0 }, { id: T0.id, ix: 1 }], [100_000_000n - 2n * FEE]);
    T2 = payTx([{ id: G, ix: 1 }], [50_000_000n - FEE]); // an older output (bbfa4485…:9)
    blocks = new Map();
    P = forge({ hash: "ab".repeat(32), no: 4_707_853n }, S0);
    C = forge(P, S0 + 9n, 0x11, bodyOf([T0]));
    Lt = forge(C, C.slot + 4n, 0x22, bodyOf([T1, T2]));
    for (let nonce = 0x23; ; nonce++) { // W wins the battle (lower VRF), as eb4dc3ba did
        Wt = forge(C, C.slot + 4n, nonce, bodyOf([T1, T2]));
        if (compareBytes(Wt.forged.vrf.output, Lt.forged.vrf.output) < 0) break;
    }
    for (const b of [P, C, Lt, Wt]) blocks.set(b.hash, b);

    await bs.put(P.forged.blockFetchBytes, P.forged.headerHash);
    setSelectedTipHash(P.forged.headerHash);
    configureLedgerStore("lmdb");
    await openNodeLedgerStore({ dbPath, ledgerStore: "lmdb" }, { slot: Number(P.slot), hash: P.forged.headerHash });
    expect(getLedgerStore()!.anchor()).not.toBeNull();

    peers = new Map(KEYS.map((k) => [k, new FakePeer(k, blocks)]));
    orch = new ConsensusOrchestrator({
        networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", syncFromGenesis: true,
        network: "testnet", dbPath, sync: { quorum: 2 }, validation: { workers: 1 }, blockFetchBatch: { maxRangeBlocks: 16 },
        ...(opts.praos ? { consensus: { chainSelection: "praos" } } : {}),
    } as never, {
        getPeer: (id: string) => peers.get(id) ?? [...peers.values()].find((p) => p.peerId === id) ?? null,
        pickHotPeer: () => null,
    } as never);
    orch.attachBlockStore(bs);
    const o = orch as any;
    o.kCached = 432;
    o.getEpochNonce = async () => null;
}

/** The producer's sequence: C applied; header L; RollBackward to C; header W; L's range applies with W's range downloaded behind it. */
async function replaySlotBattle(): Promise<void> {
    const o = orch as any;
    const prim = peers.get(KEYS[0]!)!;
    for (const k of KEYS) orch.registerHotPeer(k);
    expect(orch.primaryPeerKey()).toBe(prim.peerKey);
    await o.acceptPrimaryHeaders(prim, [item(C, C.slot)], [summary(C)], [""]);
    await until(() => o.halted != null || (!!getSelectedTipHash() && hex(getSelectedTipHash()!) === C.hash));
    expect(o.halted).toBeNull();

    // L's range is held until W's range has been downloaded (the incident: both arrived within a second)
    const applyRange = o.applyRange.bind(o);
    o.applyRange = async (points: Array<{ hash: string }>, bl: unknown, from: string, still?: () => boolean) => {
        if (points[0]!.hash.toLowerCase() === Lt.hash) await until(() => (o.scheduler?.peekNextBlocks()?.length ?? 0) > 0);
        return applyRange(points, bl, from, still);
    };
    await o.acceptPrimaryHeaders(prim, [item(Lt, Lt.slot)], [summary(Lt)], [""]);
    await until(() => o.rangeBuffer.length === 0); // L's range submitted
    await orch.handleRollBack({ blockHeader: { slotNumber: C.slot, hash: C.forged.headerHash } } as never, undefined, prim.peerId);
    await o.acceptPrimaryHeaders(prim, [item(Wt, Wt.slot)], [summary(Wt)], [""]);
}

describe("same-slot battle at the tip, the loser applied first, both blocks carrying the same transactions (bug 340)", () => {
    for (const [name, opts] of [
        ["lmdb, SQL ledger writes on", { sqlWrites: true, praos: false }],
        ["lmdb, SQL ledger writes off", { sqlWrites: false, praos: false }],
        ["lmdb, chainSelection praos", { sqlWrites: true, praos: true }],
    ] as const) {
        test(`${name}: the winning block validates on the rolled-back ledger (no halt)`, async () => {
            const sqlWritesBefore = process.env.GEROLAMO_LEDGER_SQL_WRITES, failedDirBefore = process.env.GEROLAMO_FAILED_BLOCK_DIR;
            process.env.GEROLAMO_FAILED_BLOCK_DIR = join(dir, "failed-blocks"); // a halt dumps the block: not into the checkout
            try {
                await txScenario(`battle-${opts.sqlWrites}-${opts.praos}`, opts);
                const o = orch as any;
                await replaySlotBattle();
                if (opts.praos) {
                    // chain selection decides in praos mode: W's range does not extend L and fails; the switch follows
                    await until(() => o.halted != null || o.recentlyRolledBack.size > 0 || hex(getSelectedTipHash()!) === Lt.hash);
                    await until(() => o.halted != null || o.scheduler?.stats().queued === 0);
                    if (!o.halted && hex(getSelectedTipHash()!) === Lt.hash) {
                        const prim = peers.get(KEYS[0]!)!;
                        await o.switchToCandidate({ peer: prim.peerKey, intersection: { slot: C.slot, hash: C.hash }, suffix: [{ slot: Wt.slot, hash: Wt.hash }], tip: { slot: Wt.slot, hash: Wt.hash, blockNo: Wt.no }, rollback: 1, reason: { kind: "equal", detail: { kind: "vrf" } } });
                    }
                }
                await until(() => o.halted != null || (!!getSelectedTipHash() && hex(getSelectedTipHash()!) === Wt.hash));
                expect(o.halted?.reason ?? null).toBeNull();
                expect(ledgerStoreBroken()).toBeNull();
                expect(hex(getSelectedTipHash()!)).toBe(Wt.hash);
                expect(hex(getLedgerStore()!.selectedTip()!)).toBe(Wt.hash);
                expect(o.recentlyRolledBack.has(Lt.hash)).toBe(true); // L was applied, then rolled back
                // the ledger is W's: T1/T2 outputs present, their inputs spent
                const has = (ref: string) => ledgerUtxoReads()!.get(ref) != null;
                expect(has(`${T1.id}:0`)).toBe(true);
                expect(has(`${T2.id}:0`)).toBe(true);
                expect(has(`${T0.id}:0`) || has(`${T0.id}:1`) || has(`${G}:1`)).toBe(false);
                if (opts.sqlWrites) { // the SQLite shadow tables followed the same chain (journal undo of L, then W)
                    const refs = ((await sql`SELECT utxo_ref FROM utxo ORDER BY utxo_ref`.values()) as unknown[][]).map((r) => String(r[0]));
                    expect(refs.sort()).toEqual([`${T1.id}:0`, `${T2.id}:0`].sort());
                }
            } finally {
                if (sqlWritesBefore == null) delete process.env.GEROLAMO_LEDGER_SQL_WRITES; else process.env.GEROLAMO_LEDGER_SQL_WRITES = sqlWritesBefore;
                if (failedDirBefore == null) delete process.env.GEROLAMO_FAILED_BLOCK_DIR; else process.env.GEROLAMO_FAILED_BLOCK_DIR = failedDirBefore;
            }
        }, 60_000);
    }
});
