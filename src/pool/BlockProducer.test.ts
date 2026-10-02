import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BabbageHeader, MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { validateHeader } from "../consensus/BlockHeaderValidator";
import { blockFetchHeaderIdentity } from "../consensus/blockHeaderParser";
import { verifyBlockBodyHash } from "../consensus/bodyHash";
import { BlockProducer, type ProducerNode } from "./BlockProducer";
import { encodeOperationalCert, issueOperationalCert, loadColdSigningKey, loadKesSigningKey, writeTextEnvelope } from "./keystore";
import { leaderSlotsForEpoch } from "./leaderSchedule";
import { slotStartMs } from "./slotClock";
import { Cbor, CborArray, CborSimple, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { splitEraBlock } from "../consensus/bodyHash";
import { splitTx } from "./bodyAssembly";

/** Whole transactions ([body, witnesses, valid, aux]) from a real preview block, for a fake mempool. */
async function fixtureTxs(): Promise<Uint8Array[]> {
    const hex = (await Bun.file(new URL("../consensus/__fixtures__/preview-block-11663879.hex", import.meta.url)).text()).trim();
    const { rawBlock } = splitEraBlock(Uint8Array.from(Buffer.from(hex, "hex")));
    const lazy = Cbor.parseLazy(rawBlock) as LazyCborArray;
    const [, bodiesRaw, witsRaw, auxRaw, invalidRaw] = lazy.array;
    const bodies = (Cbor.parseLazy(bodiesRaw!) as LazyCborArray).array;
    const wits = (Cbor.parseLazy(witsRaw!) as LazyCborArray).array;
    const aux = Cbor.parse(auxRaw!) as any;
    const auxByIx = new Map<number, Uint8Array>();
    for (const e of aux.map) auxByIx.set(Number(e.k.num), Cbor.encode(e.v).toBuffer());
    const invalid = new Set(((Cbor.parse(invalidRaw!) as CborArray).array as any[]).map((x) => Number(x.num)));
    return bodies.map((b, i) => {
        const parts = [b, wits[i]!, Cbor.encode(new CborSimple(!invalid.has(i))).toBuffer(), auxByIx.get(i) ?? new Uint8Array([0xf6])];
        const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0)); out[0] = 0x84;
        let o = 1; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    });
}
function txCountOf(blockFetchBytes: Uint8Array): number {
    const outer = Cbor.parse(blockFetchBytes) as CborArray;
    return ((outer.array[1] as CborArray).array[1] as CborArray).array.length;
}

const F = (n: string) => new URL(`./__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const nonceHex = "aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c"; // preview epoch 333
const EPOCH = 333, FIRST = 333n * 86400n;
const genesis = { activeSlotsCoeff: 0.05, slotsPerKESPeriod: 129600, maxKESEvolutions: 62 };
const config = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };

/** Keys: cli fixtures, plus an opcert issued for the KES period of the test epoch (counter 0). */
function keyFiles(dir: string) {
    const cold = loadColdSigningKey(F("cold.skey"));
    const kes = loadKesSigningKey(F("kes.skey"));
    const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, FIRST / 129600n, cold);
    const opcertFile = join(dir, "node.cert");
    writeTextEnvelope(opcertFile, encodeOperationalCert(opcert));
    return { coldVkeyFile: F("cold.vkey"), kesSkeyFile: F("kes.skey"), vrfSkeyFile: F("vrf.skey"), opcertFile, stateFile: join(dir, "producer-state.json") };
}

/** A fake node: schedule over a short window, a fixed tip, a mempool with no txs, adopt = our own validator. */
function fakeNode(clock: { now: number }, window: bigint, adopted: Uint8Array[], opts: { sigma?: { num: bigint; den: bigint }; rejectFirst?: boolean } = {}): ProducerNode {
    let tip = { slot: FIRST - 3n, blockNumber: 1_000_000n, hashHex: "11".repeat(32) };
    let rejects = opts.rejectFirst ? 1 : 0;
    return {
        network: "preview", era: 6, genesis, now: () => clock.now,
        nonceFor: async (e) => (e === EPOCH ? nonceHex : null),
        sigmaFor: async () => opts.sigma ?? { num: 1n, den: 1n },
        tip: async () => tip,
        protocolVersion: async () => ({ major: 8, minor: 0 }),
        maxBlockBodySize: async () => 90_112,
        lastOnChainOpcertCounter: async () => null,
        mempoolTxs: async () => [],
        dropFromMempool: async () => {},
        adopt: async (bytes) => {
            if (rejects > 0) { rejects--; throw new Error("simulated rule failure"); }
            const id = blockFetchHeaderIdentity(bytes);
            const hdr = BabbageHeader.fromCbor(id.rawHeaderBytes);
            if (!(await validateHeader(new MultiEraHeader({ era: 6, header: hdr }), Uint8Array.from(Buffer.from(nonceHex, "hex")), config))) throw new Error("header invalid");
            if (!verifyBlockBodyHash(bytes).ok) throw new Error("body hash");
            if (Buffer.from(hdr.body.prevHash!).toString("hex") !== tip.hashHex) throw new Error("does not extend tip");
            adopted.push(bytes);
            tip = { slot: hdr.body.slot, blockNumber: hdr.body.blockNumber, hashHex: Buffer.from(id.hash).toString("hex") };
        },
        schedule: async ({ epoch, nonceHex: n, sigma, vrf }) => leaderSlotsForEpoch({ epoch, nonceHex: n, sigma, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: FIRST, toSlot: FIRST + window }),
    };
}

async function settle(ms = 30) { await new Promise((r) => setTimeout(r, ms)); }

describe("BlockProducer", () => {
    test("loads keys, checks the opcert, schedules, forges its leader slots through the node's validation, persists state", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const node = fakeNode(clock, 300n, adopted);
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready;
        const st = producer.stats();
        expect(st.scheduledEpochs).toEqual([EPOCH]);
        expect(st.leaderSlotsKnown).toBeGreaterThan(3); // σ = 1: ≈ 15 of 300 slots
        expect(st.kesEvolution).toBe(0);
        producer.stop(); // drive slots by hand instead of the wall-clock ticker
        const leaders = leaderSlotsForEpoch({ epoch: EPOCH, nonceHex, sigma: { num: 1n, den: 1n }, activeSlotsCoeff: 0.05, vrf: (producer as any).vrf, network: "preview", fromSlot: FIRST, toSlot: FIRST + 300n }).map((s) => s.slot);
        expect(leaders.length).toBe(st.leaderSlotsKnown);
        // a non-leader slot: nothing happens
        clock.now = slotStartMs(FIRST + 1n, "preview") + 50;
        await (producer as any).onSlot(FIRST + 1n, clock.now);
        expect(adopted.length).toBe(leaders.includes(FIRST + 1n) ? 1 : 0);
        // the first three leader slots, in time: each forges one block that extends the previous
        for (const s of leaders.slice(0, 3)) {
            clock.now = slotStartMs(s, "preview") + 200;
            await (producer as any).onSlot(s, clock.now);
        }
        expect(producer.stats().forged).toBe(3);
        expect(adopted.length).toBe(3);
        expect(producer.stats().lastForgedSlot).toBe(leaders[2]!.toString());
        // block numbers chain 1_000_001.. and prev hashes link
        const hdrs = adopted.map((b) => BabbageHeader.fromCbor(blockFetchHeaderIdentity(b).rawHeaderBytes));
        expect(hdrs.map((h) => h.body.blockNumber)).toEqual([1_000_001n, 1_000_002n, 1_000_003n]);
        expect(Buffer.from(hdrs[1]!.body.prevHash!).toString("hex")).toBe(Buffer.from(blockFetchHeaderIdentity(adopted[0]!).hash).toString("hex"));
        // state persisted; a second producer will not forge the same slot again
        const state = JSON.parse(readFileSync(join(dir, "producer-state.json"), "utf8"));
        expect(state.lastForgedSlot).toBe(leaders[2]!.toString());
        const again = new BlockProducer(keyFiles(dir), node);
        await again.start(); await again.ready; again.stop();
        clock.now = slotStartMs(leaders[2]!, "preview") + 200;
        await (again as any).onSlot(leaders[2]!, clock.now);
        expect(adopted.length).toBe(3);
        // too late for a leader slot (deadline passed) → no block
        const late = leaders[3]!;
        clock.now = slotStartMs(late, "preview") + 3000;
        await (producer as any).onSlot(late, clock.now);
        expect(adopted.length).toBe(3);
        expect(existsSync(join(dir, "producer-state.json"))).toBe(true);
    }, 60_000);

    test("a block our own rules reject is not published; the slot is retried with an empty body", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const producer = new BlockProducer(keyFiles(dir), fakeNode(clock, 300n, adopted, { rejectFirst: true }));
        await producer.start(); await producer.ready; producer.stop();
        const first = [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : 1))[0]!;
        clock.now = slotStartMs(first, "preview") + 200;
        await (producer as any).onSlot(first, clock.now);
        // first attempt (empty body, since the mempool is empty) was rejected → no second attempt exists → nothing published
        expect(adopted.length).toBe(0);
        expect(producer.stats().lastError).toContain("rejected by our own rules");
        expect(producer.stats().forged).toBe(0);
    }, 60_000);

    test("σ = 0 (pool not in the snapshot) schedules no slots", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const producer = new BlockProducer(keyFiles(dir), fakeNode(clock, 300n, [], { sigma: { num: 0n, den: 1n } }));
        await producer.start(); await producer.ready; producer.stop();
        expect(producer.stats().leaderSlotsKnown).toBe(0);
        expect(producer.stats().nextLeaderSlot).toBeNull();
    }, 60_000);

    test("rejects an operational certificate from another cold key or outside its KES window", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const files = keyFiles(dir);
        const clock = { now: slotStartMs(FIRST + 70n * 129600n, "preview") }; // 70 periods later: expired
        const producer = new BlockProducer(files, fakeNode(clock, 10n, []));
        await expect(producer.start()).rejects.toThrow(/expired/);
        writeFileSync(files.opcertFile, readFileSync(F("node.cert"), "utf8")); // cli fixture cert: period 123, far in the past
        const c2 = new BlockProducer(files, fakeNode({ now: slotStartMs(FIRST, "preview") }, 10n, []));
        await expect(c2.start()).rejects.toThrow(/expired|KES period/);
    }, 60_000);
});

describe("greeting transaction", () => {
    test("the first forged block on a network carries the greeting once; later blocks and restarts do not repeat it", async () => {
        const { buildWithMinFee, generateKeyPair, messageMetadata, txId } = await import("./operator");
        const { Cbor } = await import("@harmoniclabs/cbor");
        const pay = generateKeyPair(new Uint8Array(32).fill(3));
        const greeting = buildWithMinFee({
            inputs: [{ txHash: new Uint8Array(32).fill(9), index: 0 }], outputs: [{ address: new Uint8Array(57).fill(1), lovelace: 5_000_000n }], changeIndex: 0,
            certificates: [], auxiliaryData: messageMetadata(["Gerolamo was here!"]), minFeeA: 44n, minFeeB: 155381n, keys: [pay],
        });
        let built = 0;
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-greet-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const node = fakeNode(clock, 300n, adopted);
        node.greetingTx = async () => { built++; return { hash: txId(greeting.body), bytes: greeting.tx }; };
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready;
        producer.stop();
        const leaders = leaderSlotsForEpoch({ epoch: EPOCH, nonceHex, sigma: { num: 1n, den: 1n }, activeSlotsCoeff: 0.05, vrf: (producer as any).vrf, network: "preview", fromSlot: FIRST, toSlot: FIRST + 300n }).map((l) => l.slot);
        const txCount = (block: Uint8Array): number => { const top: any = Cbor.parse(block); const blk = top.array[1]; return blk.array[1].array.length; };
        for (const s of leaders.slice(0, 2)) { clock.now = slotStartMs(s, "preview") + 50; await (producer as any).onSlot(s, clock.now); }
        expect(adopted.length).toBe(2);
        expect(txCount(adopted[0]!)).toBe(1); // the greeting
        expect(txCount(adopted[1]!)).toBe(0); // once only
        expect(built).toBe(1);
        const state = JSON.parse(readFileSync(keyFiles(dir).stateFile!, "utf8"));
        expect(state.greeted).toBe("preview");
        // a restart reads the state back: no second greeting
        const again = new BlockProducer(keyFiles(dir), node);
        await again.start(); await again.ready; again.stop();
        clock.now = slotStartMs(leaders[2]!, "preview") + 50; await (again as any).onSlot(leaders[2]!, clock.now);
        expect(adopted.length).toBe(3);
        expect(txCount(adopted[2]!)).toBe(0);
        expect(built).toBe(1);
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});

describe("BlockProducer mempool culprits", () => {
    test("a transaction our rules reject is dropped and the body retried; the block goes out with the rest", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const dropped: string[] = [];
        const txs = (await fixtureTxs()).slice(0, 2);
        expect(txs.length).toBe(2);
        const node = fakeNode(clock, 300n, adopted);
        const inner = node.adopt;
        node.mempoolTxs = async () => txs.map((t) => ({ hash: new Uint8Array(blake2b_256(t)), bytes: t }));
        node.dropFromMempool = async (hashes) => { for (const h of hashes) dropped.push(Buffer.from(h).toString("hex")); };
        node.adopt = async (bytes) => {
            // our rules: the second transaction is stale → the whole body is rejected, naming it
            if (txCountOf(bytes) === 2) throw new Error("Block body validation failed at slot x (era 6, 2 tx): tx[1]: expired: ttl 1 < slot 2");
            return inner(bytes);
        };
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready; producer.stop();
        const first = [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : 1))[0]!;
        clock.now = slotStartMs(first, "preview") + 200;
        await (producer as any).onSlot(first, clock.now);
        expect(adopted.length).toBe(1);
        expect(txCountOf(adopted[0]!)).toBe(1);
        expect(producer.stats().forged).toBe(1);
        // both the included transaction and the culprit left the mempool
        expect(new Set(dropped)).toEqual(new Set(txs.map((t) => Buffer.from(blake2b_256(t)).toString("hex"))));
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});

describe("BlockProducer forge fallback", () => {
    test("when every body with transactions is rejected the slot still gets the empty block", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const txs = (await fixtureTxs()).slice(0, 3);
        const node = fakeNode(clock, 300n, adopted);
        const inner = node.adopt;
        let rejected = 0;
        node.mempoolTxs = async () => txs.map((t) => ({ hash: new Uint8Array(blake2b_256(t)), bytes: t }));
        node.dropFromMempool = async () => {};
        node.adopt = async (bytes) => {
            // our rules keep finding a bad transaction at index 1 as long as any transaction is in the body
            if (txCountOf(bytes) > 0) { rejected++; throw new Error(`Block body validation failed at slot x (era 6, ${txCountOf(bytes)} tx): tx[${Math.min(1, txCountOf(bytes) - 1)}]: expired`); }
            return inner(bytes);
        };
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready; producer.stop();
        const first = [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : 1))[0]!;
        clock.now = slotStartMs(first, "preview") + 200;
        await (producer as any).onSlot(first, clock.now);
        expect(adopted.length).toBe(1);
        expect(txCountOf(adopted[0]!)).toBe(0);
        expect(rejected).toBe(3); // 3 → 2 → 1 transactions, then the empty body
        expect(producer.stats().forged).toBe(1);
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);

    test("txSanity results keep stale transactions out of the first attempt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const txs = (await fixtureTxs()).slice(0, 2);
        const node = fakeNode(clock, 300n, adopted);
        node.mempoolTxs = async () => txs.map((t) => ({ hash: new Uint8Array(blake2b_256(t)), bytes: t }));
        node.txSanity = async (list) => [list[1]!.hash]; // the second one expired
        const dropped: string[] = [];
        node.dropFromMempool = async (hashes) => { for (const h of hashes) dropped.push(Buffer.from(h).toString("hex")); };
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready; producer.stop();
        const first = [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : 1))[0]!;
        clock.now = slotStartMs(first, "preview") + 200;
        await (producer as any).onSlot(first, clock.now);
        expect(adopted.length).toBe(1);
        expect(txCountOf(adopted[0]!)).toBe(1);
        expect(dropped).toContain(Buffer.from(blake2b_256(txs[1]!)).toString("hex"));
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);

    test("a validating mempool's snapshot for the slot replaces mempoolTxs + txSanity", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const txs = (await fixtureTxs()).slice(0, 2);
        const node = fakeNode(clock, 300n, adopted);
        const asked: bigint[] = [];
        node.mempoolTxs = async () => { throw new Error("mempoolTxs must not be read when a snapshot exists"); };
        node.txSanity = async () => { throw new Error("txSanity must not run on a validated snapshot"); };
        node.mempoolSnapshot = async (slot) => { asked.push(slot); return [{ hash: new Uint8Array(blake2b_256(txs[0]!)), bytes: txs[0]! }]; };
        const producer = new BlockProducer(keyFiles(dir), node);
        await producer.start(); await producer.ready; producer.stop();
        const first = [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : 1))[0]!;
        clock.now = slotStartMs(first, "preview") + 200;
        await (producer as any).onSlot(first, clock.now);
        expect(asked).toEqual([first]);
        expect(adopted.length).toBe(1);
        expect(txCountOf(adopted[0]!)).toBe(1);
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});

describe("BlockProducer schedule cache", () => {
    test("a relaunch reuses the schedule from the state file instead of redoing the VRF pass", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-producer-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const node = fakeNode(clock, 300n, []);
        let passes = 0;
        const inner = node.schedule;
        node.schedule = async (input) => { passes++; return inner(input); };
        const first = new BlockProducer(keyFiles(dir), node);
        await first.start(); await first.ready; first.stop();
        expect(passes).toBe(1);
        const slotsFirst = first.stats().leaderSlots.map((l) => l.slot);
        expect(slotsFirst.length).toBeGreaterThan(0);
        const again = new BlockProducer(keyFiles(dir), node);
        await again.start(); await again.ready; again.stop();
        expect(passes).toBe(1); // cached
        expect(again.stats().leaderSlots.map((l) => l.slot)).toEqual(slotsFirst);
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});
