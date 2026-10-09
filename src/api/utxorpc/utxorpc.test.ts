import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { BlockFetchBlock, type ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import { CardanoQueryClient, CardanoSubmitClient, CardanoSyncClient, CardanoWatchClient, type CardanoTipEvent, type CardanoTxEvent, type CardanoMempoolEvent } from "@utxorpc/sdk";
import { query, submit, sync, syncConnect, queryConnect } from "@utxorpc/spec";
import { initSql, sql } from "../../sql";
import { ensureInitialized, setStrictUtxoApply, txOutColumns } from "../../db";
import { _resetEpochParamsCache, storeEpochParams } from "../../consensus/epochParams";
import { addressBech32, baseAddressBytes, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, messageMetadata, signTxBody, txId } from "../../pool/operator";
import { assembleBody, splitTx } from "../../pool/bodyAssembly";
import { BlockStore } from "../../storage/blockStore";
import { configureBlockStoreMode, setNodeBlockStore } from "../../storage/nodeBlockStore";
import { getSelectedTipHash, setSelectedTipHash } from "../../storage/blockReads";
import { configureLedgerStore, getLedgerStore, ledgerUtxoReads, openNodeLedgerStore } from "../../ledger/nodeLedgerStore";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";
import { forgeBlock, type BodySegments, type ForgedBlock } from "../../pool/forge";
import { issueOperationalCert, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey } from "../../pool/keystore";
import { ConsensusOrchestrator } from "../../consensus/ConsensusOrchestratooor";
import type { HeaderSummary } from "../../consensus/blockHeaderParser";
import { compareBytes } from "../../consensus/tieBreak";
import { bigIntValue } from "./mapper";
import { nodeProvider, type MempoolSnapshotLike, type UtxorpcProvider } from "./provider";
import { resolveUtxorpcConfig, startUtxorpcServer, type UtxorpcHandle } from "./server";

/**
 * UTxO RPC end to end: a real orchestrator, block store (primary mode) and LMDB ledger store fed
 * forged Babbage blocks with transactions (the bug-340 fixture of legacyFork.test.ts), served by
 * the gRPC server on a random port and queried with the official @utxorpc/sdk clients. The chain:
 *
 *   P ─ C(T0) ─┬─ L(T1, T2)   applied, then rolled back
 *              └─ W(T1, T2) ─ X(T3)
 */

const F = (n: string) => new URL(`../../pool/__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const SLOTS_PER_KES = 129600n;
const S0 = 124_017_567n;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex")) as Uint8Array<ArrayBuffer>;

const dir = mkdtempSync(join(tmpdir(), "gerolamo-utxorpc-"));
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
        era: 6, blockNumber: parent.no + 1n, slot, prevHash: unhex(parent.hash),
        nonce: new Uint8Array(32).fill(nonceByte), coldVkey: keys.cold.vkey, vrf: keys.vrf, kes: keys.kes, opcert: keys.opcert,
        protocolVersion: { major: 9, minor: 0 }, slotsPerKESPeriod: SLOTS_PER_KES, body,
    });
    return { slot, hash: hex(f.headerHash), prev: parent.hash, no: parent.no + 1n, forged: f };
}

class FakePeer {
    chainSyncGeneration = 1;
    chainSyncInFlight = 0;
    isTerminated = false;
    readonly source = "ledger";
    readonly chainSyncAtTip = true;
    constructor(readonly peerKey: string, private readonly blocks: Map<string, Blk>) {}
    get peerId(): string { return `${this.peerKey}:1`; }
    async restartChainSync(): Promise<void> { this.chainSyncGeneration++; }
    terminate(): void { this.isTerminated = true; }
    async fetchBlockRange(points: ChainPoint[]): Promise<BlockFetchBlock[]> {
        return points.map((p) => new BlockFetchBlock({ blockData: this.blocks.get(hex(p.blockHeader!.hash))!.forged.blockFetchBytes }));
    }
}
const summary = (b: Blk): HeaderSummary => ({ slot: b.slot, blockHeaderHash: b.forged.headerHash, era: 6, epoch: 1435, isByron: false, isEbb: false, rawHeaderBytes: b.forged.headerBytes, prevHashHex: b.prev });
const item = (b: Blk) => ({ rollForwardCborBytes: b.forged.rollForwardData, tip: b.slot });

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 10));
    }
}

const FEE = 200_000n;
const payKey = generateKeyPair(new Uint8Array(32).fill(9));
const payHash = keyHash(payKey.vkey);
const payAddrBytes = baseAddressBytes(0, payHash, payHash);
const payAddr = addressBech32(payAddrBytes);
const otherKey = generateKeyPair(new Uint8Array(32).fill(7));
const otherAddrBytes = Uint8Array.of(0x60, ...keyHash(otherKey.vkey)); // enterprise, testnet
const otherAddr = addressBech32(otherAddrBytes);
const POLICY = "c0".repeat(28), NAME1 = "746f6b656e31", NAME2 = "746f6b656e32";
const DATUM = "d8799f4568656c6c6fff"; // Constr 0 [#"hello"]
const DATUM_HASH = hex(blake2b_256(unhex(DATUM)));
const PARAMS_RAW = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", max_block_header_size: "1100", key_deposit: "2000000", pool_deposit: "500000000",
    coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "9", protocol_minor_ver: "0",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000",
    min_fee_ref_script_cost_per_byte: 15, e_max: "18", n_opt: "500", a0: "0.3", rho: "0.003", tau: "0.2",
};
interface Tx { id: string; bytes: Uint8Array }
function payTx(inputs: Array<{ id: string; ix: number }>, outputs: bigint[], meta?: string): Tx {
    const auxiliaryData = meta ? messageMetadata([meta]) : undefined;
    const body = encodeTxBody({ inputs: inputs.map((i) => ({ txHash: unhex(i.id), index: i.ix })), outputs: outputs.map((l) => ({ address: payAddrBytes, lovelace: l })), fee: FEE, certificates: [], auxiliaryData });
    return { id: hex(txId(body)), bytes: encodeSignedTx(body, signTxBody(body, [payKey]), auxiliaryData) };
}
const bodyOf = (txs: Tx[]): BodySegments => assembleBody(txs.map((t) => splitTx(unhex(t.id), t.bytes)), 90_112).segments;
const G = "11".repeat(32);

let orch: ConsensusOrchestrator;
let P: Blk, C: Blk, L: Blk, W: Blk, X: Blk, T0: Tx, T1: Tx, T2: Tx, T3: Tx;
const blocks = new Map<string, Blk>();
let peers: Map<string, FakePeer>;
const KEYS = ["76.156.32.49:5001", "127.0.0.1:6424", "77.23.179.21:4444"];
let server: UtxorpcHandle;
let uri: string;
let provider: UtxorpcProvider;

// a mempool the test controls (the SubmitService path without the validating mempool's ledger rules)
const pool: Array<{ txId: string; bytes: Uint8Array }> = [];
let poolVersion = 1;
const poolWaiters = new Set<() => void>();
const bumpPool = () => { poolVersion++; for (const w of [...poolWaiters]) w(); };
const submitted: Uint8Array[] = [];

beforeAll(async () => {
    setEpochNetwork("preview");
    configureLedgerStore("sqlite");
    const dbPath = join(dir, "preview.db");
    initSql(dbPath);
    await ensureInitialized();
    _resetEpochParamsCache();
    await storeEpochParams(1435, { ...PARAMS_RAW, epoch: 1435 }, "test");
    const funding: Array<[number, string, bigint, Record<string, Record<string, string>>, string | null]> = [
        [0, payAddr, 100_000_000n, {}, null],
        [1, payAddr, 50_000_000n, {}, null],
        [2, otherAddr, 5_000_000n, { [POLICY]: { [NAME1]: "7" } }, null],
        [3, otherAddr, 3_000_000n, { [POLICY]: { [NAME2]: "1" } }, DATUM],
    ];
    for (const [ix, addr, lovelace, assets, datum] of funding) {
        const json = JSON.stringify({ address: addr, amount: String(lovelace), assets, ...(datum ? { inline_datum: datum } : {}) });
        const c = txOutColumns(json);
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key) VALUES (${`${G}:${ix}`}, ${json}, ${G}, ${c.address}, ${c.lovelace}, ${c.referenceScriptHash}, ${c.stakeKey})`;
    }
    configureBlockStoreMode("primary");
    const bs = await BlockStore.open(join(dir, "db"), { k: 432 });
    setNodeBlockStore(bs);

    T0 = payTx([{ id: G, ix: 0 }], [60_000_000n, 40_000_000n - FEE], "hello utxorpc");
    T1 = payTx([{ id: T0.id, ix: 0 }, { id: T0.id, ix: 1 }], [100_000_000n - 2n * FEE]);
    T2 = payTx([{ id: G, ix: 1 }], [50_000_000n - FEE]);
    T3 = payTx([{ id: T1.id, ix: 0 }], [100_000_000n - 3n * FEE]);
    P = forge({ hash: "ab".repeat(32), no: 4_707_853n }, S0);
    C = forge(P, S0 + 9n, 0x11, bodyOf([T0]));
    L = forge(C, C.slot + 4n, 0x22, bodyOf([T1, T2]));
    for (let nonce = 0x23; ; nonce++) { // W wins the slot battle (lower VRF output), as the network's block would
        W = forge(C, C.slot + 4n, nonce, bodyOf([T1, T2]));
        if (compareBytes(W.forged.vrf.output, L.forged.vrf.output) < 0) break;
    }
    X = forge(W, W.slot + 7n, 0x44, bodyOf([T3]));
    for (const b of [P, C, L, W, X]) blocks.set(b.hash, b);

    await bs.put(P.forged.blockFetchBytes, P.forged.headerHash);
    setSelectedTipHash(P.forged.headerHash);
    configureLedgerStore("lmdb");
    await openNodeLedgerStore({ dbPath, ledgerStore: "lmdb" }, { slot: Number(P.slot), hash: P.forged.headerHash });

    peers = new Map(KEYS.map((k) => [k, new FakePeer(k, blocks)]));
    orch = new ConsensusOrchestrator({
        networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", syncFromGenesis: true,
        network: "testnet", dbPath, sync: { quorum: 2 }, validation: { workers: 0 }, blockFetchBatch: { maxRangeBlocks: 16 },
    } as never, { getPeer: (id: string) => peers.get(id) ?? [...peers.values()].find((p) => p.peerId === id) ?? null, pickHotPeer: () => null } as never);
    orch.attachBlockStore(bs);
    const o = orch as any;
    o.kCached = 432;
    o.getEpochNonce = async () => null;
    for (const k of KEYS) orch.registerHotPeer(k);

    const base = nodeProvider({ networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", byronGenesisFile: "src/config/preview/byron-genesis.json" }, async () => ({ status: "success" }));
    provider = {
        ...base,
        async submitTx(tx) {
            submitted.push(tx);
            const { txIdOf } = await import("./mapper");
            pool.push({ txId: hex(txIdOf(tx)), bytes: tx });
            bumpPool();
            return { accepted: true };
        },
        mempool: () => ({
            async snapshot(): Promise<MempoolSnapshotLike> { return { version: poolVersion, txs: pool.slice() }; },
            waitForChange(v, signal) {
                return new Promise<void>((resolve) => {
                    if (v !== poolVersion || signal.aborted) return resolve();
                    const w = () => { poolWaiters.delete(w); resolve(); };
                    poolWaiters.add(w);
                    signal.addEventListener("abort", w, { once: true });
                });
            },
        }),
    };
    server = await startUtxorpcServer({ host: "127.0.0.1", port: 0 }, provider);
    uri = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
    await server?.stop();
    await orch?.stop().catch(() => undefined);
    setStrictUtxoApply(false);
    getLedgerStore()?.close();
    configureLedgerStore("sqlite");
    setNodeBlockStore(null);
    rmSync(dir, { recursive: true, force: true });
});

const prim = () => peers.get(KEYS[0]!)!;
async function applyTo(b: Blk, headers: Blk[]): Promise<void> {
    const o = orch as any;
    await o.acceptPrimaryHeaders(prim(), headers.map(item), headers.map(summary), headers.map(() => ""));
    await until(() => o.halted != null || (!!getSelectedTipHash() && hex(getSelectedTipHash()!) === b.hash));
    expect(o.halted).toBeNull();
}

async function collect<T>(it: AsyncIterable<T>, stop: (xs: T[]) => boolean, ms = 30_000): Promise<T[]> {
    const out: T[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`stream timed out after ${out.length} events: ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? hex(v) : v)).slice(0, 400)}`)), ms); });
    const run = (async () => { for await (const x of it) { out.push(x); if (stop(out)) break; } return out; })();
    try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
}

/** The error message a call fails with ("" when it succeeds). Bun's `expect(p).rejects` hung on a ConnectError rejection here. */
async function errorOf(p: Promise<unknown>): Promise<string> {
    try { await p; return ""; } catch (e) { return String((e as Error)?.message ?? e); }
}

describe("UTxO RPC v1alpha over gRPC with the official SDK", () => {
    const point = (b: Blk) => ({ slot: Number(b.slot), hash: b.hash });
    let tipEvents: Promise<CardanoTipEvent[]>;
    let txEvents: Promise<CardanoTxEvent[]>;
    let payTxEvents: Promise<CardanoTxEvent[]>;

    test("config: off by default, enabled / env forms", () => {
        expect(resolveUtxorpcConfig({}, {})).toBeNull();
        expect(resolveUtxorpcConfig({ utxorpc: { port: 1 } }, {})).toBeNull();
        expect(resolveUtxorpcConfig({ utxorpc: { enabled: true } }, {})).toEqual({ host: "127.0.0.1", port: 50051 });
        expect(resolveUtxorpcConfig({ utxorpc: { enabled: true, host: "0.0.0.0", port: 50052 } }, {})).toEqual({ host: "0.0.0.0", port: 50052 });
        expect(resolveUtxorpcConfig({ utxorpc: { enabled: true } }, { GEROLAMO_UTXORPC: "0" })).toBeNull();
        expect(resolveUtxorpcConfig({}, { GEROLAMO_UTXORPC: "127.0.0.1:50077" })).toEqual({ host: "127.0.0.1", port: 50077 });
    });

    test("FollowTip and WatchTx stream the chain as it is applied, rolled back and switched", async () => {
        const syncClient = new CardanoSyncClient({ uri });
        const watchClient = new CardanoWatchClient({ uri });
        tipEvents = collect(syncClient.followTip([point(P)]), (xs) => xs.some((e) => e.action === "apply" && hex(e.block.header!.hash) === X.hash));
        txEvents = collect(watchClient.watchTx([point(P)]), (xs) => xs.some((e) => e.action === "apply" && hex(e.Tx.hash) === T3.id));
        payTxEvents = collect(watchClient.watchTxForPaymentPart(payHash as Uint8Array<ArrayBuffer>, [point(P)]), (xs) => xs.some((e) => e.action === "apply" && hex(e.Tx.hash) === T3.id));
        await new Promise((r) => setTimeout(r, 200));
        await applyTo(C, [C]);
        await applyTo(L, [L]);
        await orch.handleRollBack({ blockHeader: { slotNumber: C.slot, hash: C.forged.headerHash } } as never, undefined, prim().peerId);
        await applyTo(W, [W]);
        await applyTo(X, [X]);

        const ev = await tipEvents;
        const seq = ev.map((e) => e.action === "reset" ? `reset:${e.point.hash}` : `${e.action}:${hex(e.block.header!.hash)}`);
        expect(seq).toEqual([`reset:${P.hash}`, `apply:${C.hash}`, `apply:${L.hash}`, `undo:${L.hash}`, `apply:${W.hash}`, `apply:${X.hash}`]);
        const applyC = ev[1] as Extract<CardanoTipEvent, { action: "apply" }>;
        expect(hex(applyC.nativeBytes)).toBe(hex((await getNodeStore().byHash(C.forged.headerHash))!.bytes));
        expect(applyC.block.header!.slot).toBe(C.slot);
        expect(applyC.block.header!.height).toBe(C.no);
        expect(applyC.block.body!.tx.map((t) => hex(t.hash))).toEqual([T0.id]);
        const t0 = applyC.block.body!.tx[0]!;
        expect(bigIntValue(t0.fee)).toBe(FEE);
        expect(t0.inputs.map((i) => `${hex(i.txHash)}:${i.outputIndex}`)).toEqual([`${G}:0`]);
        expect(hex(t0.inputs[0]!.asOutput!.address)).toBe(hex(payAddrBytes)); // resolved from the ledger state before C
        expect(t0.outputs.map((o) => bigIntValue(o.coin))).toEqual([60_000_000n, 40_000_000n - FEE]);
        expect(t0.auxiliary!.metadata[0]!.label).toBe(674n);
        expect(t0.witnesses!.vkeywitness.length).toBe(1);
        expect(applyC.block.timestamp).toBeGreaterThan(1_600_000_000_000n);

        const txs = await txEvents;
        const tseq = txs.map((e) => e.action === "idle" ? `idle:${hex(e.BlockRef.hash)}` : `${e.action}:${hex(e.Tx.hash)}`);
        expect(tseq).toEqual([`apply:${T0.id}`, `apply:${T1.id}`, `apply:${T2.id}`, `undo:${T1.id}`, `undo:${T2.id}`, `apply:${T1.id}`, `apply:${T2.id}`, `apply:${T3.id}`]);
        const pt = await payTxEvents;
        expect(pt.filter((e) => e.action === "apply").length).toBe(6);
    }, 90_000);

    test("ReadTip, FetchBlock, DumpHistory", async () => {
        const c = new CardanoSyncClient({ uri });
        expect(await c.readTip()).toEqual({ slot: String(X.slot), hash: X.hash });
        const b = await c.fetchBlock(point(W));
        expect(hex(b.parsedBlock.header!.hash)).toBe(W.hash);
        expect(b.parsedBlock.body!.tx.map((t) => hex(t.hash))).toEqual([T1.id, T2.id]);
        expect(await errorOf(c.fetchBlock(point(L)))).not.toBe(""); // a dead fork's block is not on the chain
        const page = await c.inner.dumpHistory({ startToken: { slot: P.slot, hash: unhex(P.hash) }, maxItems: 3 });
        expect(page.block.map((x) => hex((x.chain.value as any).header.hash))).toEqual([P.hash, C.hash, W.hash]);
        expect(hex(page.nextToken!.hash)).toBe(X.hash);
        const hist = await c.fetchHistory(undefined, 10);
        expect(hist.map((x) => hex(x.parsedBlock.header!.hash))).toEqual([P.hash, C.hash, W.hash, X.hash]);
    });

    test("ReadUtxos and SearchUtxos (address, payment part, delegation part, asset, pagination)", async () => {
        const q = new CardanoQueryClient({ uri });
        const got = await q.readUtxosByOutputRef([{ txHash: unhex(T3.id), outputIndex: 0 }, { txHash: unhex(G), outputIndex: 0 }, { txHash: unhex(G), outputIndex: 2 }]);
        expect(got.map((u) => `${hex(u.txoRef.hash)}:${u.txoRef.index}`)).toEqual([`${T3.id}:0`, `${G}:2`]);
        expect(bigIntValue(got[0]!.parsedValued!.coin)).toBe(100_000_000n - 3n * FEE);
        expect(hex(got[0]!.parsedValued!.address)).toBe(hex(payAddrBytes));
        const refs = (us: Array<{ txoRef: { hash: Uint8Array; index: number } }>) => us.map((u) => `${hex(u.txoRef.hash)}:${u.txoRef.index}`).sort();
        const atPay = [`${T2.id}:0`, `${T3.id}:0`].sort();
        expect(refs(await q.searchUtxosByAddress(payAddrBytes as Uint8Array<ArrayBuffer>))).toEqual(atPay);
        expect(refs(await q.searchUtxosByPaymentPart(payHash as Uint8Array<ArrayBuffer>))).toEqual(atPay);
        expect(refs(await q.searchUtxosByDelegationPart(payHash as Uint8Array<ArrayBuffer>))).toEqual(atPay);
        expect(refs(await q.searchUtxosByAddress(otherAddrBytes as Uint8Array<ArrayBuffer>))).toEqual([`${G}:2`, `${G}:3`]);
        expect(refs(await q.searchUtxosByAsset(unhex(POLICY)))).toEqual([`${G}:2`, `${G}:3`]);
        expect(refs(await q.searchUtxosByAsset(unhex(POLICY), unhex(NAME2)))).toEqual([`${G}:3`]);
        expect(refs(await q.searchUtxosByAddressWithAsset(otherAddrBytes as Uint8Array<ArrayBuffer>, unhex(POLICY), unhex(NAME1)))).toEqual([`${G}:2`]);
        expect(refs(await q.searchUtxosByPaymentPartWithAsset(payHash as Uint8Array<ArrayBuffer>, unhex(POLICY)))).toEqual([]);
        const withAsset = (await q.searchUtxosByAsset(unhex(POLICY), unhex(NAME1)))[0]!;
        expect(hex(withAsset.parsedValued!.assets[0]!.policyId)).toBe(POLICY);
        expect(bigIntValue((withAsset.parsedValued!.assets[0]!.assets[0]!.quantity as any).value)).toBe(7n);
        const withDatum = (await q.searchUtxosByAsset(unhex(POLICY), unhex(NAME2)))[0]!;
        expect(hex(withDatum.parsedValued!.datum!.hash)).toBe(DATUM_HASH);
        expect(hex(withDatum.parsedValued!.datum!.originalCbor)).toBe(DATUM);
        // pagination: one item per page, the token continues after the last one returned
        const page1 = await q.inner.searchUtxos({ predicate: { match: { utxoPattern: { case: "cardano", value: { asset: { policyId: unhex(POLICY) } } } } }, maxItems: 1 });
        expect(page1.items.length).toBe(1);
        expect(page1.nextToken).not.toBe("");
        const page2 = await q.inner.searchUtxos({ predicate: { match: { utxoPattern: { case: "cardano", value: { asset: { policyId: unhex(POLICY) } } } } }, maxItems: 1, startToken: page1.nextToken });
        expect(page2.items.length).toBe(1);
        expect(page2.nextToken).toBe("");
        expect(refs([...page1.items, ...page2.items].map((x) => ({ txoRef: x.txoRef! })))).toEqual([`${G}:2`, `${G}:3`]);
        // any_of over two addresses, not
        const anyOf = await q.inner.searchUtxos({ predicate: { anyOf: [
            { match: { utxoPattern: { case: "cardano", value: { address: { exactAddress: payAddrBytes as Uint8Array<ArrayBuffer> } } } } },
            { match: { utxoPattern: { case: "cardano", value: { address: { exactAddress: otherAddrBytes } } } } },
        ], not: [{ match: { utxoPattern: { case: "cardano", value: { asset: { policyId: unhex(POLICY), assetName: unhex(NAME2) } } } } }] } });
        expect(refs(anyOf.items.map((x) => ({ txoRef: x.txoRef! })))).toEqual([...atPay, `${G}:2`].sort());
        expect(hex(anyOf.ledgerTip!.hash)).toBe(X.hash);
        expect(await errorOf(q.inner.searchUtxos({ predicate: { not: [{}] } }))).toMatch(/too broad/);
        expect(await errorOf(q.searchUtxosByPaymentPart(new Uint8Array(5) as Uint8Array<ArrayBuffer>))).toMatch(/28-byte/);
    }, 60_000);

    test("ReadData, ReadTx, ReadParams, ReadGenesis, ReadEraSummary", async () => {
        const q = new CardanoQueryClient({ uri });
        const data = await q.inner.readData({ keys: [unhex(DATUM_HASH), new Uint8Array(32)] });
        expect(data.values.length).toBe(1);
        expect(hex(data.values[0]!.nativeBytes)).toBe(DATUM);
        expect((data.values[0]!.parsedState.value as any).plutusData.case).toBe("constr");
        const tx = await q.inner.readTx({ hash: unhex(T1.id) });
        expect(hex(tx.tx!.blockRef!.hash)).toBe(W.hash);
        expect(hex((tx.tx!.chain.value as any).hash)).toBe(T1.id);
        expect(hex(tx.tx!.nativeBytes)).toBe(hex(T1.bytes));
        expect(await errorOf(q.inner.readTx({ hash: new Uint8Array(32) }))).toMatch(/not found/);
        const pp = await q.readParams();
        expect(bigIntValue(pp.coinsPerUtxoByte)).toBe(4310n);
        expect(bigIntValue(pp.minFeeCoefficient)).toBe(44n);
        expect(pp.maxTxSize).toBe(16384n);
        expect(pp.prices!.memory).toMatchObject({ numerator: 577, denominator: 10000 });
        expect(pp.protocolVersion).toMatchObject({ major: 9, minor: 0 });
        const masked = await q.inner.readParams({ fieldMask: { paths: ["values.cardano.max_tx_size"] } });
        expect((masked.values!.params.value as any).maxTxSize).toBe(16384n);
        expect((masked.values!.params.value as any).minFeeCoefficient).toBeUndefined();
        const g = await q.readGenesis();
        expect(g.networkMagic).toBe(2);
        expect(g.epochLength).toBe(86400);
        expect(g.protocolConsts!.k).toBe(432);
        const gr = await q.inner.readGenesis({});
        expect(gr.caip2).toBe("cardano:preview");
        expect(hex(gr.genesis)).toBe(hex(blake2b_256(readFileSync("src/config/preview/shelley-genesis.json"))));
        const eras = await q.readErasummary();
        expect(eras.map((e) => e.name)).toEqual(["byron", "shelley", "allegra", "mary", "alonzo", "babbage"]);
        expect(eras[5]!.start!.epoch).toBe(3n);
        expect(eras[5]!.start!.time).toBe(BigInt(Date.parse("2022-10-25T00:00:00Z")) + 3n * 86_400_000n);
        expect(bigIntValue(eras[5]!.protocolParams!.coinsPerUtxoByte)).toBe(4310n);
    });

    test("SubmitTx, ReadMempool, WatchMempool, WaitForTx (mempool, then confirmed by a block)", async () => {
        const s = new CardanoSubmitClient({ uri });
        const T4 = payTx([{ id: T3.id, ix: 0 }], [100_000_000n - 4n * FEE]);
        const watched = collect(s.watchMempoolForPaymentPart(payHash as Uint8Array<ArrayBuffer>), (xs) => xs.length >= 1);
        const stages = collect(s.waitForTx(unhex(T4.id)), (xs) => xs.includes(submit.Stage.CONFIRMED));
        await new Promise((r) => setTimeout(r, 200));
        const ref = await s.submitTx(T4.bytes);
        expect(hex(ref)).toBe(T4.id);
        const w: CardanoMempoolEvent[] = await watched;
        expect(hex(w[0]!.txoRef)).toBe(T4.id);
        expect(hex(w[0]!.Tx!.inputs[0]!.asOutput!.address)).toBe(hex(payAddrBytes));
        const mp = await s.inner.readMempool({});
        expect(mp.items.map((i) => hex(i.ref))).toEqual([T4.id]);
        expect(mp.items[0]!.stage).toBe(submit.Stage.MEMPOOL);
        // a block carries it
        const Y = forge(X, X.slot + 3n, 0x55, bodyOf([T4]));
        blocks.set(Y.hash, Y);
        await applyTo(Y, [Y]);
        expect(await stages).toEqual([submit.Stage.MEMPOOL, submit.Stage.CONFIRMED]);
        // already on chain: confirmed at once
        expect(await collect(s.waitForTx(unhex(T1.id)), () => false)).toEqual([submit.Stage.CONFIRMED]);
        expect(await errorOf(s.submitTx(new Uint8Array([1, 2, 3])))).toMatch(/does not decode/);
    }, 60_000);

    test("EvalTx: fee and no redeemers for a key-only transaction; missing inputs reported", async () => {
        const s = new CardanoSubmitClient({ uri });
        const spend = payTx([{ id: T2.id, ix: 0 }], [50_000_000n - 2n * FEE]);
        const r = await s.evalTx(spend.bytes);
        const report = r.report!.chain.value as any;
        expect(report.errors).toEqual([]);
        expect(report.redeemers).toEqual([]);
        expect(bigIntValue(report.fee)).toBe(44n * BigInt(spend.bytes.length) + 155381n);
        const ghost = payTx([{ id: "22".repeat(32), ix: 0 }], [1_000_000n]);
        const r2 = (await s.evalTx(ghost.bytes)).report!.chain.value as any;
        expect(r2.errors.map((e: any) => e.msg)).toEqual([`input ${"22".repeat(32)}:0 is not in the UTxO set`]);
    });

    test("gRPC-Web and Connect over HTTP/1.1 on the same port", async () => {
        for (const t of [createConnectTransport({ baseUrl: uri, httpVersion: "1.1" }), createGrpcWebTransport({ baseUrl: uri, httpVersion: "1.1" })]) {
            const c = createPromiseClient(syncConnect.SyncService, t);
            const tip = await c.readTip({});
            expect(tip.tip!.height).toBeGreaterThan(X.no);
            const ac = new AbortController();
            const ev: sync.FollowTipResponse[] = [];
            try { for await (const e of c.followTip({ intersect: [{ slot: W.slot, hash: unhex(W.hash) }] }, { signal: ac.signal })) { ev.push(e); if (ev.length === 3) ac.abort(); } } catch { /* aborted */ }
            expect(ev.map((e) => e.action.case)).toEqual(["reset", "apply", "apply"]);
            const qc = createPromiseClient(queryConnect.QueryService, t);
            const u = await qc.readUtxos(new query.ReadUtxosRequest({ keys: [{ hash: unhex(G), index: 2 }] }));
            expect(u.items.length).toBe(1);
        }
        const r = await fetch(`${uri}/utxorpc.v1alpha.sync.SyncService/ReadTip`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(r.status).toBe(200);
        expect((await r.json()).tip.slot).toBeDefined();
    });

    test("the LMDB UTxO set agrees (sanity)", () => {
        expect(ledgerUtxoReads()!.get(`${G}:2`)).not.toBeNull();
    });
});

function getNodeStore(): BlockStore { return (provider.blockStore() as BlockStore); }
