import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CborArray, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { LedgerStore } from "../ledger/LedgerStore";
import { StakeReads } from "../ledger/stakeStore";
import { CborWriter } from "../network/n2c/lsq/cborWriter";
import { nonMyopicOfLedgerState } from "../consensus/nonMyopicSeed";
import { importStateToLmdb } from "./importLmdb";
import type { LedgerSnapshot, SnapshotPool, StakeSnapshot } from "./nesDecoder";

const root = mkdtempSync(join(tmpdir(), "gerolamo-import-lmdb-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const u = (n: number | bigint) => new CborUInt(BigInt(n));
const r = (n: number, d: number) => new CborTag(30, new CborArray([u(n), u(d)]));
/** A Conway PParams array with the shape conwayPParamsToRaw reads (values arbitrary). */
function conwayPParams(): CborArray {
    const a: CborObj[] = [u(44), u(155381), u(90112), u(16384), u(1100), u(2000000), u(500000000), u(18), u(500), r(3, 10), r(3, 1000), r(1, 5),
        new CborArray([u(10), u(0)]), u(170000000), u(4310), new CborMap([]), new CborArray([r(577, 10000), r(721, 10000000)]), new CborArray([u(14000000), u(10000000000)]),
        new CborArray([u(62000000), u(20000000000)]), u(5000), u(150), u(3), new CborArray(Array.from({ length: 5 }, () => r(51, 100))), new CborArray(Array.from({ length: 10 }, () => r(67, 100))),
        u(0), u(365), u(30), u(100000000000), u(500000000), u(20), r(15, 1)];
    return new CborArray(a);
}
const ID = (c: string) => c.repeat(56);
const pool = (stake: bigint, delegators: number): SnapshotPool => ({ stake, ratioNum: 0n, ratioDen: 1n, owners: [], ownerStake: 0n, vrf: "ab".repeat(32), pledge: 0n, cost: 340000000n, marginNum: 0n, marginDen: 1n, delegators, rewardAccount: { type: 0, hash: "cd".repeat(28) } });
function snapshotWith(snaps: { mark: StakeSnapshot; set: StakeSnapshot; go: StakeSnapshot }, likelihoods: Map<string, Float32Array>): LedgerSnapshot {
    const pp = conwayPParams();
    return {
        slot: 1000, blockHash: "11".repeat(32), blockNo: 10, epoch: 7, blocksPrev: new Map(), blocksCur: new Map(), treasury: 0n, reserves: 1000n,
        umap: [], genDelegs: new Map(), irwdEmpty: true, pools: new Map(), futurePools: new Map(), retiring: new Map(), dreps: [], committeeState: new Map(), dormantEpochs: 0,
        deposited: 0n, fees: 0n, donation: 0n, incrementalStake: new Map(),
        gov: { roots: {} as never, proposals: [], committee: null, constitution: { anchor: { url: "", hash: "00".repeat(32) }, script: null }, curPParams: pp, prevPParams: pp, futurePParams: { kind: "none" },
            pulsing: { proposalIds: [], drepDistr: new Map(), drepStateCount: 0, poolDistr: new Map(), enacted: [], expired: [], delayed: false } },
        snapshots: { ...snaps, fee: 0n }, poolDistr: { pools: new Map(), total: 0n }, nonMyopicRewardPot: 123n, nonMyopicLikelihoods: likelihoods, stashedAvvm: false,
        praos: { lastSlot: 999, ocertCounters: new Map(), evolving: "22".repeat(32), candidate: "33".repeat(32), epochNonce: "44".repeat(32), previousEpochNonce: null, lab: null, lastEpochBlock: null },
    };
}

describe("importStateToLmdb", () => {
    // Bug 370: a fresh import wrote no `snap_pool_zero` rows, so GetPoolDistr / GetPoolDistr2 and the
    // pulser's SPO distribution of the imported snapshots missed the pools whose delegators hold nothing.
    test("pools with delegators but no stake are recorded as zero-stake pools of each snapshot", async () => {
        const A = ID("a"), Z = ID("b"), N = ID("c");
        const snap: StakeSnapshot = { stake: new Map([["e0".repeat(28), { stake: 5n, pool: A }]]), pools: new Map([[A, pool(5n, 2)], [Z, pool(0n, 3)], [N, pool(0n, 0)]]) };
        const dir = join(root, "zero");
        await importStateToLmdb({ ledgerDir: dir, snapshot: snapshotWith({ mark: snap, set: snap, go: snap }, new Map()) });
        const st = LedgerStore.open(dir, { readOnly: true });
        try {
            const sr = new StakeReads(st);
            for (const e of [5, 6, 7]) { expect(sr.snapshotZeroPools(e)).toEqual([Z]); expect(sr.snapshotPoolStake(e).get(A)).toBe(5n); }
        } finally { st.close(); }
    });

    test("the pool-ranking likelihoods are stored bit for bit", async () => {
        const l = Float32Array.from({ length: 100 }, (_, i) => 0.0158 - i * 1e-4);
        const dir = join(root, "nm");
        const empty: StakeSnapshot = { stake: new Map(), pools: new Map() };
        await importStateToLmdb({ ledgerDir: dir, snapshot: snapshotWith({ mark: empty, set: empty, go: empty }, new Map([[ID("a"), l]])) });
        const st = LedgerStore.open(dir, { readOnly: true });
        try {
            const nm = new StakeReads(st).nonMyopic(7)!;
            expect(nm.rewardPot).toBe(123n);
            expect([...nm.likelihoods.get(ID("a"))!]).toEqual([...l]);
        } finally { st.close(); }
    });
});

// Bug 371: @harmoniclabs/cbor decodes float32/float64 in the platform's byte order (byte-swapped on
// x86), so decodeLedgerSnapshot reads the likelihoods with nonMyopicOfLedgerState from the raw bytes.
describe("nonMyopicOfLedgerState", () => {
    test("reads big-endian float32 likelihoods exactly, including values whose swapped bits are a NaN", () => {
        // 0x3c80ff7f byte-swapped is 0x7fff803c, a NaN whose payload a Float32Array round trip may not keep
        const bits = [0x3c81834e, 0x3c80ff7f, 0xbf800000];
        const w = new CborWriter();
        // [1, [telescope(7: … Conway = [bound, [2, [tip, NES, transition]]]), header]]
        w.array(2).uint(1).array(2).array(7);
        for (let i = 0; i < 6; i++) w.uint(0);
        w.array(2).uint(0).array(2).uint(2).array(3).uint(0);
        w.array(4).uint(1441).uint(0).uint(0); // NES: epoch, blocksPrev, blocksCur, EpochState
        w.array(4).uint(0).uint(0).uint(0).array(2).map(1).hex(ID("a")).array(bits.length);
        const raw = w.finish();
        const floats = new Uint8Array(bits.length * 5);
        bits.forEach((b, i) => { floats[i * 5] = 0xfa; new DataView(floats.buffer).setUint32(i * 5 + 1, b, false); });
        const tail = new CborWriter(); tail.uint(987654321).uint(0).uint(0);
        const state = new Uint8Array([...raw, ...floats, ...tail.finish()]);
        const nm = nonMyopicOfLedgerState(state);
        expect(nm.epoch).toBe(1441);
        expect(nm.rewardPot).toBe(987654321n);
        const got = nm.likelihoods.get(ID("a"))!;
        const dv = new DataView(new ArrayBuffer(4));
        expect([...got].map((x) => { dv.setFloat32(0, x, false); return dv.getUint32(0, false); })).toEqual(bits);
    });
});
