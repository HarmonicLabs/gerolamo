/**
 * The watchdog's continuous verification (parityProbe.ts) against fake node-to-client sockets (a
 * minimal mux server speaking handshake, LocalStateQuery and ChainSync FindIntersect) and a fake
 * cardano-cli script.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { cborEnd } from "./lsq";
import {
    diffSlots, dueFor, epochNow, evaluate, findIntersect, judgeForge, lockHolder, parityTick, parseLeadershipSlots, readHistory, recordRun,
    releaseLock, resolveTargets, runForgeChecks, runParity, runProbe, runScheduleCheck, shelleyGenesisOf, takeLock, writeHistory,
    type NodeHistory, type NodeMetrics, type ParityHostConfig, type ParityRun, type ParityTarget,
} from "./parityProbe";
import { epochForSlot } from "../../src/utils/epochFromSlotCalculations";

const dir = mkdtempSync(join(tmpdir(), "parity-"));
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); });

const U = (n: number | bigint) => new CborUInt(n);
const A = (xs: CborObj[]) => new CborArray(xs);
const B = (h: string) => new CborBytes(Uint8Array.from(Buffer.from(h, "hex")));
const enc = (o: CborObj) => Buffer.from(Cbor.encode(o).toBuffer());
const num = (o: CborObj) => Number((o as CborUInt).num);
const hex = (o: CborObj) => Buffer.from((o as CborBytes).bytes).toString("hex");
const h32 = (c: string) => c.repeat(64).slice(0, 64);

interface Fake { tip: { slot: number; hash: string; blockNo: number }; chain: Set<string>; epoch: number; tag5?: CborObj }
/** The answer of a fake node to a LocalStateQuery query, given the point it acquired. */
function answer(f: Fake, q: CborArray, acquired: string): Buffer {
    const top = num(q.array[0]!);
    if (top === 3) { const [s, h] = acquired.split(":"); return enc(A([U(BigInt(s!)), B(h!)])); }
    if (top !== 0) return enc(U(0));
    const inner = q.array[1] as CborArray, k = num(inner.array[0]!);
    if (k === 2) return enc(U(6)); // GetCurrentEra (and GetInterpreter: anything, the same on both)
    if (k !== 0) return enc(U(1));
    const eq = inner.array[1] as CborArray, era = num(eq.array[0]!), tag = num((eq.array[1] as CborArray).array[0]!);
    if (era !== 6) return enc(A([U(0)]));
    if (tag === 1) return enc(A([U(f.epoch)]));
    if (tag === 5 && f.tag5) return enc(A([f.tag5]));
    if (tag === 27) return enc(A([A([new CborMap([])])]));
    if (tag === 31) return enc(A([A([])]));
    return enc(A([new CborMap([])]));
}
/** A fake node-to-client server: handshake (v23), LocalStateQuery (7), ChainSync FindIntersect (5). */
async function fakeNode(name: string, f: Fake): Promise<string> {
    const path = join(dir, `${name}.socket`);
    const srv = createServer((sock) => {
        let inbox = Buffer.alloc(0), acquired = `${f.tip.slot}:${f.tip.hash}`;
        const pend = new Map<number, Buffer>();
        const send = (proto: number, payload: Buffer) => { for (let o = 0; o < payload.length; o += 12288) { const part = payload.subarray(o, o + 12288); const h = Buffer.alloc(8); h.writeUInt16BE(proto | 0x8000, 4); h.writeUInt16BE(part.length, 6); sock.write(Buffer.concat([h, part])); } };
        const handle = (proto: number, msg: CborArray) => {
            const tag = num(msg.array[0]!);
            if (proto === 0) return send(0, enc(A([U(1), U(0x8000 | 23), A([U(2), new CborSimple(false)])])));
            if (proto === 7) {
                if (tag === 0 || tag === 6) {
                    const pt = msg.array[1] as CborArray, key = pt.array.length ? `${num(pt.array[0]!)}:${hex(pt.array[1]!)}` : "origin";
                    if (f.chain.has(key)) { acquired = key; return send(7, enc(A([U(1)]))); }
                    return send(7, enc(A([U(2), U(1)])));
                }
                if (tag >= 8 && tag <= 11) { acquired = `${f.tip.slot}:${f.tip.hash}`; return send(7, enc(A([U(1)]))); }
                if (tag === 3) return send(7, Buffer.concat([Buffer.from([0x82, 0x04]), answer(f, msg.array[1] as CborArray, acquired)]));
                return;
            }
            if (proto === 5 && tag === 4) {
                const tip = A([A([U(f.tip.slot), B(f.tip.hash)]), U(f.tip.blockNo)]);
                const hit = ((msg.array[1] as CborArray).array as CborArray[]).find((p) => f.chain.has(`${num(p.array[0]!)}:${hex(p.array[1]!)}`));
                send(5, enc(hit ? A([U(5), hit, tip]) : A([U(6), tip])));
            }
        };
        sock.on("data", (chunk: Buffer) => {
            inbox = Buffer.concat([inbox, chunk]);
            while (inbox.length >= 8) {
                const proto = inbox.readUInt16BE(4) & 0x7fff, len = inbox.readUInt16BE(6);
                if (inbox.length < 8 + len) break;
                let buf = Buffer.concat([pend.get(proto) ?? Buffer.alloc(0), inbox.subarray(8, 8 + len)]);
                inbox = inbox.subarray(8 + len);
                for (let end = cborEnd(buf, 0); end > 0; end = cborEnd(buf, 0)) { handle(proto, Cbor.parse(buf.subarray(0, end)) as CborArray); buf = buf.subarray(end); }
                pend.set(proto, buf);
            }
        });
        sock.on("error", () => { /* client gone */ });
    });
    await new Promise<void>((r) => srv.listen(path, () => r()));
    servers.push(srv);
    return path;
}

const NOW = Date.now();
const EP = epochNow("preview", NOW);
const WALL = EP.wallSlot;
const fast = { attempts: 2, waitMs: 5, liveAttempts: 2, retryWaitMs: 5 };
const tipA = { slot: WALL - 5, hash: h32("a"), blockNo: 1000 };
const target = (socket: string, relay: string, extra: Partial<ParityTarget> = {}): ParityTarget =>
    ({ name: "node", network: "preview", port: 1, producer: false, socket, magic: 2, relay: { socket: relay, cardanoCli: "/nonexistent" }, vrfSkeyFile: null, ...extra });
const run = (at: number, diffs: string[], extra: Partial<ParityRun> = {}): ParityRun =>
    ({ at, ms: 1, point: `${WALL}:${h32("a")}`, pointSlot: WALL, epoch: EP.epoch, shared: true, total: 61, same: 61 - diffs.length, diffs: diffs.map((name) => ({ name, same: false, ours: 10, ref: 12, firstDiff: 3 })), ...extra });

describe("parity run against fake sockets", () => {
    test("one block on both sides; a differing answer is named with sizes and offset", async () => {
        const ours = await fakeNode("ours1", { tip: tipA, chain: new Set([`${tipA.slot}:${tipA.hash}`]), epoch: EP.epoch, tag5: A([U(7)]) });
        const ref = await fakeNode("ref1", { tip: { ...tipA, slot: tipA.slot + 20, hash: h32("b") }, chain: new Set([`${tipA.slot}:${tipA.hash}`, `${tipA.slot + 20}:${h32("b")}`]), epoch: EP.epoch });
        const r = await runParity(target(ours, ref), {}, undefined, undefined, fast);
        expect(r.error).toBeUndefined();
        expect(r.shared).toBe(true);
        expect(r.pointSlot).toBe(tipA.slot);
        expect(r.total).toBe(61); // the n2c-compare set without the huge three
        expect(r.diffs.map((d) => d.name)).toEqual(["[5] GetStakeDistribution"]);
        expect(r.diffs[0]).toMatchObject({ ours: 3, ref: 2, firstDiff: 1 }); // 81 81 07 vs 81 a0
        expect(r.results!.find((x) => x.name.includes("GetUTxOWhole"))).toBeUndefined();
    });
    test("relay cannot acquire our tip: we acquire the relay's; skip list honoured", async () => {
        const ours = await fakeNode("ours2", { tip: tipA, chain: new Set([`${tipA.slot}:${tipA.hash}`, `${tipA.slot - 20}:${h32("c")}`]), epoch: EP.epoch });
        const ref = await fakeNode("ref2", { tip: { slot: tipA.slot - 20, hash: h32("c"), blockNo: 999 }, chain: new Set([`${tipA.slot - 20}:${h32("c")}`]), epoch: EP.epoch });
        const r = await runParity(target(ours, ref), { skip: ["GetDRep", "wrong era"] }, undefined, undefined, fast);
        expect(r.shared).toBe(true);
        expect(r.pointSlot).toBe(tipA.slot - 20);
        expect(r.total).toBe(61 - 6 - 2); // [25], [26], [39] twice each; the two wrong-era queries
        expect(r.same).toBe(r.total);
    });
    test("no common block: own tips, failed connection recorded as an error run", async () => {
        const ours = await fakeNode("ours3", { tip: tipA, chain: new Set([`${tipA.slot}:${tipA.hash}`]), epoch: EP.epoch });
        const ref = await fakeNode("ref3", { tip: { slot: tipA.slot, hash: h32("d"), blockNo: 1000 }, chain: new Set([`${tipA.slot}:${h32("d")}`]), epoch: EP.epoch });
        const r = await runParity(target(ours, ref), {}, undefined, undefined, fast);
        expect(r.shared).toBe(false);
        expect(r.diffs.map((d) => d.name)).toEqual(["GetChainPoint"]); // a live answer: retried, then reported
        const bad = await runParity(target(join(dir, "missing.socket"), ref), {}, undefined, undefined, fast);
        expect(bad.error).toBeTruthy();
    });
});

describe("alerts from the history", () => {
    const t = target("/o", "/r");
    test("a difference in two consecutive completed runs, not in one", () => {
        const h: NodeHistory = { runs: [run(NOW - 3600e3, ["[24] GetGovState", "[5] GetStakeDistribution"]), run(NOW - 1800e3, ["[24] GetGovState"])] };
        const a = evaluate(t, h, null, {}, NOW);
        expect(a.map((x) => x.key)).toEqual(["node:parity"]);
        expect(a[0]!.text).toContain("[24] GetGovState (ours 10 B, relay 12 B, first difference at byte 3)");
        expect(a[0]!.text).not.toContain("GetStakeDistribution");
        expect(evaluate(t, { runs: [run(NOW - 3600e3, ["[24] GetGovState"]), run(NOW - 1800e3, [])] }, null, {}, NOW)).toEqual([]);
        // an error run between two completed ones does not break the pair
        const e = evaluate(t, { runs: [run(NOW - 5400e3, ["X"]), run(NOW - 3600e3, [], { error: "timeout" }), run(NOW - 1800e3, ["X"])] }, null, {}, NOW);
        expect(e.map((x) => x.key)).toEqual(["node:parity"]);
    });
    test("probe failing twice, probe stale", () => {
        const f = evaluate(t, { runs: [run(NOW - 3600e3, [], { error: "connect ENOENT" }), run(NOW - 1800e3, [], { error: "connect ENOENT" })] }, null, {}, NOW);
        expect(f).toEqual([expect.objectContaining({ key: "node:parity-probe", urgent: false })]);
        expect(evaluate(t, { runs: [run(NOW - 3 * 3600e3, [])] }, { tipSlot: WALL }, {}, NOW)[0]?.title).toContain("not running");
        expect(evaluate(t, { runs: [run(NOW - 3 * 3600e3, [])] }, null, {}, NOW)).toEqual([]); // node down: its own alert
        expect(evaluate(t, { runs: [run(NOW - 3 * 3600e3, [])] }, { tipSlot: WALL - 3600 }, {}, NOW)).toEqual([]); // catching up
    });
    test("recordRun keeps per-query results for the newest runs only", () => {
        const nh: NodeHistory = { runs: [] };
        for (let i = 0; i < 7; i++) recordRun(nh, { ...run(i, []), results: [] }, { historyRuns: 5, detailRuns: 2 });
        expect(nh.runs.map((r) => r.at)).toEqual([2, 3, 4, 5, 6]);
        expect(nh.runs.map((r) => !!r.results)).toEqual([false, false, false, true, true]);
    });
});

describe("what is due", () => {
    const t = target("/o", "/r", { producer: true, vrfSkeyFile: "/keys/vrf.skey" });
    const metrics = (extra: Partial<NonNullable<NodeMetrics["producer"]>> = {}, uptimeSec = 7200): NodeMetrics =>
        ({ tipSlot: WALL, uptimeSec, producer: { poolId: "aa", scheduledEpochs: [EP.epoch], leaderSlots: [], nextLeaderSlot: null, ...extra } });
    test("parity: interval, retry gap, epoch boundary", () => {
        expect(dueFor(t, undefined, null, {}, NOW).parity).toBe(true);
        expect(dueFor(t, { runs: [run(NOW - 10 * 60e3, [])] }, null, {}, NOW).parity).toBe(false);
        expect(dueFor(t, { runs: [run(NOW - 31 * 60e3, [])] }, null, {}, NOW).parity).toBe(true);
        expect(dueFor(t, { runs: [run(NOW - 31 * 60e3, [])], lastAttempt: NOW - 60e3 }, null, {}, NOW).parity).toBe(false);
        expect(dueFor(t, { runs: [run(NOW - 31 * 60e3, [])] }, { tipSlot: WALL - 601 }, {}, NOW).parity).toBe(false); // catching up
        expect(dueFor(t, { runs: [run(NOW - 31 * 60e3, [])] }, { tipSlot: WALL - 60 }, {}, NOW).parity).toBe(true);
        const at = EP.startMs + 4 * 60e3; // 4 min into the epoch; the last run acquired a block of the previous one
        const before = { runs: [run(EP.startMs - 5 * 60e3, [], { pointSlot: EP.startSlot - 300 })] };
        expect(dueFor(t, before, null, {}, at).why).toContain(`epoch ${EP.epoch} boundary`);
        expect(dueFor(t, before, null, {}, EP.startMs + 60e3).parity).toBe(false); // too early: nodes still crossing
        const after = { runs: [...before.runs, run(EP.startMs + 3.5 * 60e3, [], { pointSlot: EP.startSlot + 200 })] };
        expect(dueFor(t, after, null, {}, at).parity).toBe(false);
        const lagging = { runs: [...before.runs, run(EP.startMs + 3.5 * 60e3, [], { pointSlot: EP.startSlot - 10 })], lastAttempt: EP.startMs + 3.5 * 60e3 };
        expect(dueFor(t, lagging, null, {}, EP.startMs + 7 * 60e3).why).toContain(`epoch ${EP.epoch} boundary`); // retried until a run lands past it
    });
    test("schedule: once per epoch, after a restart, retry after failure", () => {
        expect(dueFor(t, { runs: [] }, metrics(), {}, NOW).schedule).toBe(true);
        expect(dueFor(t, { runs: [] }, metrics({ scheduledEpochs: [EP.epoch - 1] }), {}, NOW).schedule).toBe(false); // producer has no schedule yet
        const done = { runs: [], schedule: { at: NOW - 60e3, epoch: EP.epoch, producerStartedAt: NOW - 7200e3, ref: [1], ours: [1], failures: 0 } };
        expect(dueFor(t, done, metrics(), {}, NOW).schedule).toBe(false);
        expect(dueFor(t, done, metrics({}, 300), {}, NOW).why).toContain("schedule after a producer restart");
        const failed = { runs: [], schedule: { ...done.schedule, error: "x", failures: 1, at: NOW - 16 * 60e3 } };
        expect(dueFor(t, failed, metrics(), {}, NOW).schedule).toBe(true);
        expect(dueFor({ ...t, vrfSkeyFile: null }, { runs: [] }, metrics(), {}, NOW).schedule).toBe(false);
    });
    test("forge: new settled outcome, changed outcome, periodic re-check", () => {
        const ls = [{ slot: String(WALL - 2000), epoch: EP.epoch, outcome: "confirmed", hash: h32("e") }, { slot: String(WALL - 100), epoch: EP.epoch, outcome: "adopted", hash: h32("f") }];
        expect(dueFor(t, { runs: [] }, metrics({ leaderSlots: ls }), {}, NOW).why).toContain(`forged slot ${WALL - 2000}`);
        const chk = { at: NOW - 60e3, slot: WALL - 2000, hash: h32("e"), outcome: "confirmed", relayTip: WALL, onRelay: true, verdict: "agree" as const };
        const h = { runs: [], forge: { [String(WALL - 2000)]: chk } };
        expect(dueFor(t, h, metrics({ leaderSlots: ls }), {}, NOW).forge).toBe(false); // the adopted one is not settled yet
        expect(dueFor(t, h, metrics({ leaderSlots: [{ ...ls[0]!, outcome: "ghosted" }] }), {}, NOW).forge).toBe(true);
        expect(dueFor(t, h, metrics({ leaderSlots: ls }), {}, NOW + 31 * 60e3).forge).toBe(true);
    });
});

describe("leader schedule check (fake cardano-cli)", () => {
    const argsFile = join(dir, "cli-args.txt");
    const cli = join(dir, "fake-cardano-cli");
    const vrf = join(dir, "vrf.skey");
    const genesis = join(dir, "shelley-genesis.json");
    writeFileSync(vrf, ""); writeFileSync(genesis, "{}");
    const slots = [EP.startSlot + 100, EP.startSlot + 5000];
    writeFileSync(cli, `#!/bin/bash\nprintf '%s\\n' "$@" > '${argsFile}'\nif [ -n "$FAIL" ]; then echo 'secret-key-material cbor 5840deadbeef' >&2; exit 1; fi\necho '${JSON.stringify(slots.map((s) => ({ slotNumber: s, slotTime: "2026-10-01T00:00:00Z" })))}'\n`);
    chmodSync(cli, 0o755);
    const m: NodeMetrics = { tipSlot: WALL, uptimeSec: 100, producer: { poolId: h32("9").slice(0, 56), scheduledEpochs: [EP.epoch], leaderSlots: slots.map((s) => ({ slot: String(s), epoch: EP.epoch, outcome: "upcoming", hash: null })) } };

    test("cardano-cli gets the key path and --current; slots compared", async () => {
        const relay = await fakeNode("relay-s", { tip: tipA, chain: new Set(), epoch: EP.epoch });
        const t = target("/o", relay, { producer: true, vrfSkeyFile: vrf, relay: { socket: relay, cardanoCli: cli } });
        const s = await runScheduleCheck(t, m, genesis, undefined, NOW);
        expect(s.error).toBeUndefined();
        expect(s.ref).toEqual(slots);
        const args = readFileSync(argsFile, "utf8").trim().split("\n");
        expect(args.slice(0, 3)).toEqual(["conway", "query", "leadership-schedule"]);
        expect(args[args.indexOf("--vrf-signing-key-file") + 1]).toBe(vrf);
        expect(args[args.indexOf("--socket-path") + 1]).toBe(relay);
        expect(args[args.indexOf("--testnet-magic") + 1]).toBe("2");
        expect(args).toContain("--current");
        // the tick compares the producer's live schedule with cardano-cli's answer
        const h: NodeHistory = { runs: [], schedule: s };
        expect(evaluate(t, h, m, {}, NOW)).toEqual([]);
        const lost = { ...m, producer: { ...m.producer!, leaderSlots: [m.producer!.leaderSlots![0]!, { slot: String(EP.startSlot + 7), epoch: EP.epoch, outcome: "upcoming", hash: null }] } };
        const a = evaluate(t, h, lost, {}, NOW);
        expect(a.map((x) => x.key)).toEqual(["node:schedule"]);
        expect(a[0]!.text).toContain(`Only cardano-cli: ${EP.startSlot + 5000}`);
        expect(a[0]!.text).toContain(`Only ours: ${EP.startSlot + 7}`);
        expect(diffSlots([1, 2], [2, 3])).toEqual({ missing: [1], extra: [3] });
    });
    test("failures: no stderr content in the record; relay in another epoch", async () => {
        const relay = await fakeNode("relay-f", { tip: tipA, chain: new Set(), epoch: EP.epoch });
        const t = target("/o", relay, { producer: true, vrfSkeyFile: vrf, relay: { socket: relay, cardanoCli: cli } });
        process.env.FAIL = "1";
        const s = await runScheduleCheck(t, m, genesis, undefined, NOW);
        delete process.env.FAIL;
        expect(s.error).toContain("exited with 1");
        expect(JSON.stringify(s)).not.toContain("secret");
        expect(JSON.stringify(s)).not.toContain("deadbeef");
        const s2 = await runScheduleCheck(t, m, genesis, s, NOW);
        expect(s2.failures).toBe(0);
        const other = await fakeNode("relay-e", { tip: tipA, chain: new Set(), epoch: EP.epoch - 1 });
        const s3 = await runScheduleCheck({ ...t, relay: { socket: other, cardanoCli: cli } }, m, genesis, s2, NOW);
        expect(s3.error).toContain(`epoch ${EP.epoch - 1}`);
        expect(s3.ref).toEqual(slots); // the epoch's earlier answer is kept
        expect(s3.failures).toBe(1);
        expect((await runScheduleCheck({ ...t, vrfSkeyFile: join(dir, "nope") }, m, genesis, undefined, NOW)).error).toContain("vrfSkeyFile");
        expect(parseLeadershipSlots("not json")).toBeNull();
        expect(parseLeadershipSlots('[{"slotNumber":5},{"slotNumber":3}]')).toEqual([3, 5]);
    });
});

describe("post-forge check (relay ChainSync)", () => {
    test("producer outcome against the relay's chain", async () => {
        const blocks = { a: WALL - 5000, b: WALL - 4000, c: WALL - 3000, d: WALL - 2000 };
        const relay = await fakeNode("relay-c", { tip: { slot: WALL, hash: h32("1"), blockNo: 5 }, chain: new Set([`${blocks.a}:${h32("a")}`, `${blocks.d}:${h32("d")}`]), epoch: EP.epoch });
        const r = await findIntersect(relay, 2, [{ slot: blocks.a, hash: h32("a") }, { slot: blocks.b, hash: h32("b") }]);
        expect(r).toEqual([{ found: true, tip: WALL }, { found: false, tip: WALL }]);
        const t = target("/o", relay, { producer: true });
        const m: NodeMetrics = { tipSlot: WALL, producer: { leaderSlots: [
            { slot: String(blocks.a), epoch: EP.epoch, outcome: "confirmed", hash: h32("a") }, // on the relay: agree
            { slot: String(blocks.b), epoch: EP.epoch, outcome: "confirmed", hash: h32("b") }, // not there: disagree
            { slot: String(blocks.c), epoch: EP.epoch, outcome: "ghosted", hash: h32("c") },   // not there: agree
            { slot: String(blocks.d), epoch: EP.epoch, outcome: "stolen", hash: h32("d") },    // there: disagree
            { slot: String(WALL - 60), epoch: EP.epoch, outcome: "adopted", hash: h32("e") },  // too recent
            { slot: String(WALL - 1500), epoch: EP.epoch, outcome: "missed", hash: null },
        ] } };
        const nh: NodeHistory = { runs: [], forge: { "1": { at: 0, slot: 1, hash: "", outcome: "confirmed", relayTip: 0, onRelay: true, verdict: "disagree" } } };
        const checks = await runForgeChecks(t, m, nh, {}, NOW);
        expect(checks.map((c) => [c.slot, c.verdict])).toEqual([[blocks.a, "agree"], [blocks.b, "disagree"], [blocks.c, "agree"], [blocks.d, "disagree"]]);
        expect(nh.forge!["1"]).toBeUndefined(); // outside the window: forgotten
        const a = evaluate(t, nh, m, {}, NOW);
        expect(a.map((x) => x.key)).toEqual([`node:forge-${blocks.b}`, `node:forge-${blocks.d}`]);
        expect(a[0]!.text).toContain("does not hold it");
        expect(judgeForge("confirmed", false, 1000, 500, 900)).toBe("pending"); // relay not far enough past the slot
    });
});

/** A process whose command line names the probe (bash would exec a lone `sleep` and lose the name), once it shows in /proc. */
async function fakeProbe() {
    const child = spawn("bash", ["-c", "sleep 20; true", "parity-probe"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
        try { if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").includes("sleep 20")) break; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 10));
    }
    return child;
}

describe("lock, tick, end to end", () => {
    test("lock: exclusive, stale lock replaced, live holder respected", async () => {
        const lock = join(dir, "t.lock");
        expect(takeLock(lock, "bun")).toBe(true);
        expect(takeLock(lock, "bun")).toBe(false); // this test process holds it
        releaseLock(lock);
        expect(existsSync(lock)).toBe(false);
        writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 0 })); // no such process
        expect(takeLock(lock)).toBe(true);
        releaseLock(lock);
        const child = await fakeProbe();
        try {
            writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt: 0 }));
            expect(lockHolder(lock)).toBe(child.pid!);
            expect(takeLock(lock)).toBe(false);
        } finally { child.kill("SIGTERM"); rmSync(lock, { force: true }); }
    });

    test("targets and relay derived from the node config and the relay's process entry", () => {
        const relayDir = join(dir, "relay"), nodeDir = join(dir, "node1");
        mkdirSync(join(relayDir, "share/preview"), { recursive: true }); mkdirSync(nodeDir, { recursive: true });
        writeFileSync(join(relayDir, "share/preview/config.json"), JSON.stringify({ ShelleyGenesisFile: "shelley-genesis.json" }));
        writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ n2cSocketPath: join(nodeDir, "node.socket"), producer: { vrfSkeyFile: "/keys/vrf.skey" } }));
        const cfg: ParityHostConfig = {
            stateFile: join(dir, "state.json"), logFile: join(dir, "wd.log"),
            nodes: [{ name: "p", network: "preview", port: 1, dir: nodeDir, producer: true }, { name: "d", network: "preview", port: 2, dir: join(dir, "none") }, { name: "q", network: "preprod", port: 3, dir: nodeDir }],
            processes: [{ name: "preview cardano-node relay", cwd: relayDir, cmd: ["bin/cardano-node", "run", "--config", "share/preview/config.json", "--socket-path", "sock/node.socket"] }],
        };
        const ts = resolveTargets(cfg);
        expect(ts.map((t) => t.name)).toEqual(["p"]); // d: no socket; q: no preprod relay
        expect(ts[0]).toMatchObject({ socket: join(nodeDir, "node.socket"), magic: 2, vrfSkeyFile: "/keys/vrf.skey", relay: { socket: join(relayDir, "sock/node.socket"), cardanoCli: join(relayDir, "bin/cardano-cli") } });
        expect(shelleyGenesisOf(cfg, "preview")).toBe(join(relayDir, "share/preview/shelley-genesis.json"));
        expect(resolveTargets({ ...cfg, parity: { enabled: false } })).toEqual([]);
    });

    test("runProbe writes the history; the tick alerts and spawns only when due and unlocked", async () => {
        const e2e = join(dir, "e2e"); mkdirSync(e2e, { recursive: true });
        const cli = join(e2e, "cli"), vrf = join(e2e, "vrf.skey"), genesis = join(e2e, "genesis.json");
        const forged = WALL - 3000;
        const slots = [EP.startSlot + 10, forged].filter((s) => Number(epochForSlot(s, "preview")) === EP.epoch); // the epoch's leader slots, forged ones included
        writeFileSync(cli, `#!/bin/bash\necho '${JSON.stringify(slots.map((s) => ({ slotNumber: s, slotTime: "t" })))}'\n`); chmodSync(cli, 0o755);
        writeFileSync(vrf, ""); writeFileSync(genesis, "{}");
        const chain = new Set([`${tipA.slot}:${tipA.hash}`]);
        const ours = await fakeNode("e2e-ours", { tip: tipA, chain, epoch: EP.epoch, tag5: A([U(1)]) });
        const relay = await fakeNode("e2e-relay", { tip: { slot: WALL, hash: h32("7"), blockNo: 9 }, chain: new Set([...chain, `${WALL}:${h32("7")}`]), epoch: EP.epoch });
        const nodeDir = join(e2e, "node"); mkdirSync(nodeDir);
        writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ n2cSocketPath: ours, producer: { vrfSkeyFile: vrf } }));
        const cfg: ParityHostConfig = { stateFile: join(e2e, "state.json"), logFile: join(e2e, "watchdog.log"), nodes: [{ name: "prod", network: "preview", port: 1, dir: nodeDir, producer: true }],
            parity: { relays: { preview: { socket: relay, cardanoCli: cli, shelleyGenesis: genesis } } } };
        const cfgPath = join(e2e, "config.json"); writeFileSync(cfgPath, JSON.stringify(cfg));
        const m: NodeMetrics = { tipSlot: WALL, uptimeSec: 1000, producer: { poolId: h32("9").slice(0, 56), scheduledEpochs: [EP.epoch], nextLeaderSlot: null,
            leaderSlots: [{ slot: String(slots[0]), epoch: EP.epoch, outcome: "upcoming", hash: null }, { slot: String(forged), epoch: Number(epochForSlot(forged, "preview")), outcome: "confirmed", hash: h32("8") }] } };
        const out: string[] = [];
        const r1 = await runProbe(cfgPath, { metrics: async () => m, print: (s) => out.push(s) });
        expect(r1.ran.sort()).toEqual(["prod:forge", "prod:parity", "prod:schedule"]);
        const hist = readHistory(join(e2e, "parity-history.json"));
        expect(hist.nodes.prod!.runs[0]!.diffs.map((d) => d.name)).toEqual(["[5] GetStakeDistribution"]);
        expect(hist.nodes.prod!.schedule!.ref).toEqual(slots);
        expect(hist.nodes.prod!.forge![String(forged)]!.verdict).toBe("disagree"); // confirmed on ours, absent on the relay
        expect(readFileSync(cfg.logFile, "utf8")).toContain("parity prod: 60 of 61 same");
        expect(existsSync(join(e2e, "parity.lock"))).toBe(false);

        // one differing run: not yet a parity alert; the forge disagreement is
        const spawns: string[] = [];
        const spawner = (p: string) => { spawns.push(p); return 4242; };
        let tick = parityTick(cfg, cfgPath, { prod: m }, Date.now(), () => {}, spawner);
        expect(tick.alerts.map((a) => a.key)).toEqual([`prod:forge-${forged}`]);
        expect(spawns).toEqual([]); // nothing due right after a run
        // a second differing run → the parity alert names the query
        const r2 = await runProbe(cfgPath, { metrics: async () => m, print: () => {}, force: ["parity"] });
        expect(r2.ran).toContain("prod:parity");
        tick = parityTick(cfg, cfgPath, { prod: m }, Date.now(), () => {}, spawner);
        expect(tick.alerts.map((a) => a.key).sort()).toEqual([`prod:forge-${forged}`, "prod:parity"].sort());
        // due later: spawned, unless a live probe holds the lock
        tick = parityTick(cfg, cfgPath, { prod: m }, Date.now() + 31 * 60e3, () => {}, spawner);
        expect(spawns).toEqual([cfgPath]);
        const child = await fakeProbe();
        try {
            writeFileSync(join(e2e, "parity.lock"), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
            parityTick(cfg, cfgPath, { prod: m }, Date.now() + 31 * 60e3, () => {}, spawner);
            expect(spawns.length).toBe(1);
            expect((await runProbe(cfgPath, { metrics: async () => m, print: () => {}, force: ["parity"] })).skipped).toContain("lock");
        } finally { child.kill("SIGTERM"); rmSync(join(e2e, "parity.lock"), { force: true }); }
        // a corrupt history makes the tick throw (the watchdog then keeps its parity problems open)
        writeHistory(join(e2e, "parity-history.json"), hist);
        writeFileSync(join(e2e, "parity-history.json"), "{trunc");
        expect(() => parityTick(cfg, cfgPath, { prod: m }, Date.now(), () => {}, spawner)).toThrow();
    }, 30_000);
});
