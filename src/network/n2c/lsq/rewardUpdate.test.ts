import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbor, CborArray, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { LedgerStore } from "../../../ledger/LedgerStore";
import { GovReads, GovWrites } from "../../../ledger/govStore";
import { StakeReads, StakeWrites } from "../../../ledger/stakeStore";
import { UtxoReads } from "../../../ledger/utxoStore";
import type { NonMyopicState } from "../../../consensus/nonMyopic";
import { CborWriter } from "./cborWriter";
import type { Ctx } from "./queries";
import { memberReward, pulsePlan, rewardUpdateCore, setRewardWindowSource, writeRewardUpdate, type WindowFacts } from "./rewardUpdate";

// The reward update in progress (bug 264) on a synthetic preview epoch: SNothing before the
// randomness stabilisation window, the RSLP pulser visiting ⌈N/4k⌉ credentials per block in
// credential order, completion one block after the stake is used up or past 8k/f slots. The bytes
// themselves were compared with cardano-node 11.0.1 on preview epoch 1437 (docs/VALIDATION_STATUS.md).
const E = 1437, FIRST = E * 86_400, START = FIRST + 34_560, FORCE = START + 34_560;
const N = 3_500; // ⌈3500 / 1728⌉ = 3 per pulse, 1167 pulses
const P1 = "a1".repeat(28), P2 = "a2".repeat(28);
const cred = (i: number) => (i % 7 === 0 ? "01" : "") + i.toString(16).padStart(56, "0"); // every 7th a script
const OWNER = cred(1), ACCOUNT = cred(2), NEWREG = cred(3), DEREGGED = "ee".repeat(28);
const tmp: string[] = [];
let st: LedgerStore, stake: StakeReads, gov: GovReads;
let window: WindowFacts = { blocks: 1, firstOp: new Map() };
const nm: NonMyopicState = { epoch: E, rewardPot: 12_345n, likelihoods: new Map([[P1, Float32Array.from({ length: 100 }, (_, i) => i / 10)]]) };
const g = { activeSlotsCoeff: 0.05, epochLength: 86_400, maxLovelaceSupply: 45_000_000_000_000_000n };

beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsq-rupd-")); tmp.push(dir);
    st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024, persistDiffs: false });
    const w = new StakeWrites(st), gw = new GovWrites(st);
    await st.applyDirect(() => {
        w.recordPotSnapshot(E, { reserves: 7_000_000_000_000_000n, treasury: 1n, feesCollected: 1_700_000_000n });
        gw.putEpochParams(E - 1, { rho: 0.003, tau: 0.2, a0: 0.3, n_opt: 500, protocol_major_ver: 10, protocol_minor_ver: 0 }, "local");
        const pp = (owner: string, account: string) => ({ pledge: "1000000000", cost: "340000000", marginNum: "1", marginDen: "20", rewardAccount: account, owners: [owner] });
        w.putSnapshotPoolParams(E - 2, P1, "b1".repeat(32), pp(OWNER, ACCOUNT));
        w.putSnapshotPoolParams(E - 2, P2, "b2".repeat(32), pp("cc".repeat(28), "cc".repeat(28)));
        let total = 0n, p1 = 0n, p2 = 0n;
        for (let i = 1; i <= N; i++) {
            const s = BigInt(1_000_000_000 + i * 1_000_003), pool = i % 5 === 0 ? P2 : P1;
            w.putSnapshotCred(E - 2, cred(i), pool, s);
            total += s; if (pool === P1) p1 += s; else p2 += s;
            w.registerStake(cred(i)); // NEWREG among them: registered inside the window
        }
        w.putSnapshotPool(E - 2, P1, p1); w.putSnapshotPool(E - 2, P2, p2);
        w.putSnapshotTotals(E - 2, total, 2);
        w.putSnapshotPoolMeta(E - 2, P1, 2_801, [OWNER]);
        w.putBlocksMade(E - 1, P1, 1_000); // P2 made none: a likelihood, no reward info
    });
    await st.setAnchor({ slot: FIRST + 100, hash: new Uint8Array(32) });
    stake = new StakeReads(st); gov = new GovReads(st);
    setRewardWindowSource(async () => window);
});
afterAll(async () => { setRewardWindowSource(null); st.close(); for (const d of tmp) await rm(d, { recursive: true, force: true }); });

const ctxAt = (slot: number): Ctx => ({ view: { point: { slot: BigInt(slot), hash: "00".repeat(32), blockNo: 1n, era: 6 }, stake, gov, utxo: new UtxoReads(st), atTip: true, volatileHashes: [], anchorKey: "t" }, env: { network: "preview", magic: 2 } as Ctx["env"], stake, gov, epoch: E, slot });
async function ru(slot: number, blocks?: number, firstOp = new Map<string, "reg" | "dereg">()): Promise<CborObj> {
    if (blocks != null) window = { blocks, firstOp };
    const w = new CborWriter(1 << 20);
    await writeRewardUpdate(ctxAt(slot), w, nm);
    return Cbor.parse(w.finish());
}
const arr = (o: CborObj | undefined): CborObj[] => (o instanceof CborTag ? arr(o.data) : (o as CborArray).array);
const entries = (o: CborObj | undefined) => (o as CborMap).map;
const uint = (o: CborObj | undefined) => BigInt((o as CborUInt).num);
const credHex = (o: CborObj) => { const a = arr(o); return (uint(a[0]) === 1n ? "01" : "") + Buffer.from((a[1] as unknown as { bytes: Uint8Array }).bytes).toString("hex"); };

describe("the reward update in progress (DebugNewEpochState nesRu)", () => {
    test("pulse plan: ⌈N / 4k⌉ credentials per pulse", () => {
        expect(pulsePlan(N, 432)).toEqual({ size: 3, pulses: 1_167 });
        expect(pulsePlan(0, 432)).toEqual({ size: 1, pulses: 0 });
        expect(pulsePlan(1_728, 432)).toEqual({ size: 1, pulses: 1_728 });
    });
    test("SNothing up to the randomness stabilisation window", async () => {
        expect(arr(await ru(START)).length).toBe(0);
    });
    test("the first block of the window starts the pulser: nothing visited, every credential pending", async () => {
        const r = arr(await ru(START + 1, 1, new Map([[NEWREG, "reg"], [DEREGGED, "dereg"]])));
        const [tag, snap, rslp] = arr(r[0]);
        expect(uint(tag)).toBe(0n);
        const s = arr(snap);
        expect(uint(s[0])).toBe(1_700_000_000n);                        // fees
        expect(arr(s[1]).map(uint)).toEqual([10n, 0n]);                 // previous parameters' version
        expect(uint(arr(s[2])[1])).toBe(12_345n);                        // esNonMyopic as is
        expect(entries(s[6]).length).toBe(2);                            // a likelihood for each go pool
        expect(entries(s[7]).map((e) => credHex(e.k))).toEqual([ACCOUNT]); // P1's leader reward
        const [size, free, balance, ans] = arr(rslp);
        expect(uint(size)).toBe(3n);
        const addrs = arr(arr(free)[0]).map(credHex);
        expect(addrs).toContain(DEREGGED);                              // deregistered in the window: registered at its start
        expect(addrs).not.toContain(NEWREG);                            // registered in the window: not yet
        expect(entries(arr(free)[3]).length).toBe(1);                    // reward info of the pool that made blocks
        expect(entries(balance).length).toBe(N);
        expect(arr(ans).map((m) => entries(m).length)).toEqual([0, 0]);
    });
    test("ten pulses: 30 credentials visited in credential order, the last pulse's events", async () => {
        const [, , rslp] = arr(arr(await ru(START + 5_000, 11))[0]);
        const [, , balance, ans] = arr(rslp);
        const core = rewardUpdateCore(stake, gov, E, g);
        expect(entries(balance).map((e) => credHex(e.k))).toEqual(core.active.slice(30).map((a) => a.typed));
        const expected = core.active.slice(0, 30).filter((a) => memberReward(core, a));
        const [accum, recent] = arr(ans).map(entries);
        expect(accum!.map((e) => credHex(e.k))).toEqual(expected.map((a) => a.typed));
        expect(recent!.map((e) => credHex(e.k))).toEqual(core.active.slice(27, 30).filter((a) => memberReward(core, a)).map((a) => a.typed));
        expect(core.active.slice(0, 5).every((a) => a.typed.startsWith("01"))).toBe(true); // script credentials first
    });
    test("all stake visited: still pulsing with nothing pending; the next block completes", async () => {
        const [tag, , rslp] = arr(arr(await ru(FORCE - 10, 1_168))[0]);
        expect(uint(tag)).toBe(0n);
        expect(entries(arr(rslp)[2]).length).toBe(0);
        expect(uint(arr(arr(await ru(FORCE - 5, 1_169))[0])[0])).toBe(1n);
    });
    test("Complete: every reward, ΔR back to the reserves, the likelihoods advanced", async () => {
        const c = arr(arr(await ru(FORCE + 1))[0]);
        expect(uint(c[0])).toBe(1n);
        const [dT, negDR, rs, negDF, nm2] = arr(c[1]);
        const core = rewardUpdateCore(stake, gov, E, g);
        expect(uint(dT)).toBe(core.deltaT1);
        expect(uint(negDF)).toBe(1_700_000_000n);
        let sum = 0n;
        for (const e of entries(rs)) for (const x of arr(e.v)) sum += uint(arr(x)[2]);
        expect(uint(negDR)).toBe(core.deltaR1 - (core.R - sum));
        // the pool's account delegates to it as well: its leader reward sorts before its member reward
        const acct = entries(rs).find((e) => credHex(e.k) === ACCOUNT)!;
        expect(arr(acct.v).map((x) => uint(arr(x)[0]))).toEqual([1n, 0n]);
        // the self-delegated owner earns through the leader reward only
        expect(entries(rs).some((e) => credHex(e.k) === OWNER)).toBe(false);
        // P2 made no blocks: its delegators earn nothing; the account is among P1's members
        expect(entries(rs).length).toBe(core.active.filter((a) => memberReward(core, a)).length);
        expect(core.active.filter((a) => a.pool === P2).some((a) => memberReward(core, a))).toBe(false);
        expect(uint(arr(nm2)[1])).toBe(core.R);
        expect(entries(arr(nm2)[0]).length).toBe(2);
    });
});
