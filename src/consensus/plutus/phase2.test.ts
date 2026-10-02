import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { DataB, DataConstr, DataI, DataList, DataMap, DataPair, dataToCbor } from "@harmoniclabs/plutus-data";
import { outputLike } from "../rules/blockRulesPure";
import { epochParamsFromRecord } from "../epochParams";
import { getEpochNetwork, setEpochNetwork } from "../../utils/epochFromSlotCalculations";
import { checkMempoolTxBytesPhase2, evaluatePhase2Sync, slotToPosixMs, verdictOf, type Phase2Input } from "../rules/phase2";
import type { ResolvedUtxo } from "../rules/resolvedUtxo";
import { decodeData, encodeData, fromLibData, intSize } from "./data";
import { costTable, namedParams } from "./costs";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "./paramNames";

/** A replay job (scripts/plutus-replay.ts --dump-dir, trimmed by scripts/plutus-fixture.ts) as a phase-2 input. */
function loadJob(name: string): { job: any; input: Phase2Input } {
    const job = JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
    setEpochNetwork(job.network);
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, h] of job.resolved as Array<[string, string]>) {
        const o = outputLike(TxOut.fromCbor(h));
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    }
    const params = epochParamsFromRecord(0, job.params);
    return { job, input: { era: job.era, bodyBytes: Buffer.from(job.bodyHex, "hex"), witnessSetBytes: Buffer.from(job.witnessHex, "hex"), resolved, params, markedInvalid: !job.valid } };
}

describe("Plutus phase 2 on real preview transactions (budgets equal aiken's uplc crate)", () => {
    // [fixture, redeemer, cpu, mem]; each figure checked with tools/uplc-ref eval-tx
    const cases: Array<[string, string, bigint, bigint]> = [
        ["plutus-preview-64834939-0.json", "0:0 V3 (secp256k1 ECDSA, integerToByteString)", 279652490n, 632245n],
        ["plutus-preview-95107576-0.json", "1:0 V2 (three Ed25519 oracle signatures)", 284206491n, 307346n],
        ["plutus-preview-95071833-2.json", "1:0 V3 (blake2b_224 of serialiseData)", 115254906n, 341202n],
        ["plutus-preview-804660-0.json", "1:0 V2 (Babbage, 10⁹ declared)", 386488181n, 1372760n],
        ["plutus-preview-61828322-0.json", "0:1 V3 (BLS12-381 G1 compress/uncompress, 9.1·10⁹ cpu)", 9133733892n, 4952050n],
        ["plutus-preview-117653313-0.json", "0:1 V3 protocol 11 (`case` on builtin constants)", 204130933n, 568774n],
        ["plutus-preview-119711898-0.json", "V3 protocol 11 (dropList, batch 6)", 0n, 0n],
        ["plutus-preview-124008114-0.json", "0:0 V2 protocol 11 (semantics variant D; spends exactly the declared units)", 468052646n, 1534186n],
        ["plutus-preview-120070481-4.json", "3:1 V3 protocol 11 (bls12_381_G1_multiScalarMul of 77 points, batch 6; exactly the declared units)", 7930226502n, 1384862n],
    ];
    for (const [f, what, cpu, mem] of cases) {
        test(`${f}: ${what}`, () => {
            const { input } = loadJob(f);
            const r = evaluatePhase2Sync(input);
            expect(r.error).toBeNull();
            expect(r.ok).toBe(true);
            if (cpu) expect(r.redeemers.find((x) => x.spent?.cpu === cpu)?.spent).toEqual({ cpu, mem });
            for (const x of r.redeemers) { expect(x.spent!.cpu <= x.declared.cpu && x.spent!.mem <= x.declared.mem).toBe(true); }
            expect(verdictOf(input, r)).toEqual({ kind: "ok" });
        });
    }

    test("evaluation never mutates the transaction bytes (Buffer#slice views shared with the block)", () => {
        const { input } = loadJob("plutus-preview-95107576-0.json");
        const before = Buffer.from(input.witnessSetBytes).toString("hex");
        evaluatePhase2Sync(input);
        evaluatePhase2Sync(input);
        expect(Buffer.from(input.witnessSetBytes).toString("hex")).toBe(before);
    });

    test("the verdict must equal is_valid: the same scripts flagged invalid are a tag mismatch", () => {
        const { input } = loadJob("plutus-preview-64834939-0.json");
        const r = evaluatePhase2Sync({ ...input, markedInvalid: true });
        expect(verdictOf({ ...input, markedInvalid: true }, r).kind).toBe("tag-mismatch");
    });

    test("a script over its declared units fails (ValidationTagMismatch on the mempool path)", () => {
        const { job, input } = loadJob("plutus-preview-804660-0.json");
        // lower the declared cpu of the only redeemer below what it spends: rebuild the tx with the witness set patched
        const w = Buffer.from(job.witnessHex, "hex");
        const declared = Buffer.from("1b00000002540be400", "hex"); // 10^10 as a CBOR uint64
        const at = w.indexOf(declared);
        expect(at).toBeGreaterThan(0);
        const patched = Buffer.concat([w.subarray(0, at), Buffer.from("1a0bebc200", "hex"), w.subarray(at + declared.length)]); // 2·10^8
        const tx = Buffer.concat([Buffer.from([0x84]), input.bodyBytes, patched, Buffer.from([0xf5, 0xf6])]);
        const m = checkMempoolTxBytesPhase2(tx, input.era, input.resolved, input.params);
        expect(m.failure?.kind).toBe("ValidationTagMismatch");
        expect(m.failure?.detail).toContain("budget exceeded");
        const ok = checkMempoolTxBytesPhase2(Buffer.concat([Buffer.from([0x84]), input.bodyBytes, w, Buffer.from([0xf5, 0xf6])]), input.era, input.resolved, input.params);
        expect(ok.failure).toBeNull();
    });
});

describe("cost models are named per language exactly as the ledger does", () => {
    test("V1 and V2 list their appended parameters in their own orders", () => {
        expect(PARAM_NAMES_V1.slice(166, 170)).toEqual(["serialiseData-cpu-arguments-intercept", "serialiseData-cpu-arguments-slope", "serialiseData-memory-arguments-intercept", "serialiseData-memory-arguments-slope"]);
        expect(PARAM_NAMES_V2.indexOf("serialiseData-cpu-arguments-intercept")).toBe(133);
        expect(PARAM_NAMES_V2.indexOf("integerToByteString-cpu-arguments-c0")).toBe(175);
        expect(PARAM_NAMES_V1.indexOf("integerToByteString-cpu-arguments-c0")).toBe(223);
        expect(PARAM_NAMES_V3.length).toBeGreaterThanOrEqual(350);
    });
    test("a short list leaves the missing parameters at maxBound; a long one ignores the extras", () => {
        const short = namedParams(2, new Array(175).fill(7));
        expect(short.get("serialiseData-cpu-arguments-intercept")).toBe(7n);
        expect(short.get("integerToByteString-cpu-arguments-c0")).toBe(9223372036854775807n);
        const long = namedParams(3, new Array(400).fill(1));
        expect(long.size).toBe(PARAM_NAMES_V3.length);
    });
    test("a V2 script using a post-Chang builtin is costed from the V2 list, not V3 defaults", () => {
        const cm = JSON.parse(readFileSync(new URL("../__fixtures__/preview-costmodels-1413.json", import.meta.url), "utf8")); // 332-entry V1/V2 lists
        const v2: number[] = cm.PlutusV2;
        expect(v2.length).toBe(332);
        const t = costTable(2, v2);
        const i2b = t.builtins[73]!; // integerToByteString
        const idx = PARAM_NAMES_V2.indexOf("integerToByteString-memory-arguments-slope");
        expect(i2b.mem.at(0, 0, 3)).toBe(Number(v2[PARAM_NAMES_V2.indexOf("integerToByteString-memory-arguments-intercept")]) + 3 * Number(v2[idx]));
    });
});

describe("Plutus Data codec", () => {
    const samples = [
        new DataConstr(0, [new DataI(0n), new DataI(23n), new DataI(24n), new DataI(-1n), new DataI(-25n)]),
        new DataConstr(7, []), new DataConstr(127, [new DataB(new Uint8Array(70).fill(3))]), new DataConstr(128, [new DataList([])]),
        new DataMap([new DataPair(new DataI(1n), new DataList([new DataI(1n << 70n), new DataI(-(1n << 80n))]))]),
        new DataList([new DataB(new Uint8Array(0)), new DataB(new Uint8Array(64).fill(1)), new DataB(new Uint8Array(65).fill(2))]),
        new DataI(18446744073709551615n), new DataI(18446744073709551616n), new DataI(-18446744073709551616n), new DataI(-18446744073709551617n),
    ];
    test("serialiseData equals plutus-data's (patched to the ledger's encoding) and round-trips", () => {
        for (const d of samples) {
            const ours = encodeData(fromLibData(d));
            expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(dataToCbor(d).toBuffer()).toString("hex"));
            expect(Buffer.from(encodeData(decodeData(ours))).toString("hex")).toBe(Buffer.from(ours).toString("hex"));
        }
    });
    test("integer sizes are 64-bit words", () => {
        expect(intSize(0n)).toBe(1);
        expect(intSize((1n << 63n) - 1n)).toBe(1);
        expect(intSize(1n << 64n)).toBe(2);
        expect(intSize(-(1n << 127n))).toBe(2);
        expect(intSize(1n << 128n)).toBe(3);
    });
});

describe("script contexts for Conway governance and the V1/V2 translation limits", () => {
    const { Cbor, CborArray, CborBytes, CborMap, CborUInt, CborSimple, CborTag } = require("@harmoniclabs/cbor");
    const { TxContext, ContextError } = require("./context");
    const h = (n: number, b: number) => new CborBytes(new Uint8Array(n).fill(b));
    const u = (n: number) => new CborUInt(BigInt(n));
    // a Conway body: one vote by a DRep script, one proposal (treasury withdrawal guarded by a policy), a donation
    const body = new CborMap([
        { k: u(0), v: new CborTag(258, new CborArray([new CborArray([h(32, 1), u(0)])])) },
        { k: u(1), v: new CborArray([]) },
        { k: u(2), v: u(200000) },
        { k: u(19), v: new CborMap([{ k: new CborArray([u(3), h(28, 0xd1)]), v: new CborMap([{ k: new CborArray([h(32, 7), u(2)]), v: new CborArray([u(1), new CborSimple(null)]) }]) }]) },
        { k: u(20), v: new CborTag(258, new CborArray([new CborArray([u(100000000000), new CborBytes(Uint8Array.from([0xf0, ...new Uint8Array(28).fill(0xaa)])), new CborArray([u(2), new CborMap([{ k: new CborBytes(Uint8Array.from([0xe0, ...new Uint8Array(28).fill(0xbb)])), v: u(5) }]), h(28, 0xcc)]), new CborArray([new CborSimple(null), h(32, 0)])])])) },
        { k: u(22), v: u(1000) },
    ]);
    const wits = new CborMap([{ k: u(5), v: new CborMap([{ k: new CborArray([u(4), u(0)]), v: new CborArray([u(0), new CborArray([u(1000), u(1000)])]) }, { k: new CborArray([u(5), u(0)]), v: new CborArray([u(0), new CborArray([u(1000), u(1000)])]) }]) }]);
    const resolved = new Map([[`${"01".repeat(32)}:0`, { ref: "", address: "addr_test1vr6lx0dk534vvv93js4n0qnqs0y9mkxtursdwc7ed7szeqgur3u54", value: new Map([["lovelace", 5_000_000n]]), referenceScriptHash: null, hasDatum: false }]]) as any;
    const ctx = new TxContext({ era: 7, pv: 10, bodyBytes: Cbor.encode(body).toBuffer(), witnessSetBytes: Cbor.encode(wits).toBuffer(), resolved, slotToPosixMs: (s: bigint) => s * 1000n });

    test("voting and proposing redeemers resolve to the DRep script and the guardrail policy", () => {
        const vote = ctx.purposeOf({ tag: 4, index: 0 })!;
        const prop = ctx.purposeOf({ tag: 5, index: 0 })!;
        expect(ctx.scriptHashOf(vote)).toBe("d1".repeat(28));
        expect(ctx.scriptHashOf(prop)).toBe("cc".repeat(28));
        // V3 ScriptInfo: VotingScript (DRepVoter (ScriptCredential h)) / ProposingScript 0 (ProposalProcedure …)
        const vi: any = ctx.scriptInfoData(vote);
        expect(vi.tag).toBe(4n);
        expect(vi.fields[0].tag).toBe(1n); // DRepVoter
        expect(vi.fields[0].fields[0].tag).toBe(1n); // ScriptCredential
        const pi: any = ctx.scriptInfoData(prop);
        expect(pi.tag).toBe(5n);
        expect(pi.fields[0].v).toBe(0n);
        const pp = pi.fields[1];
        expect(pp.fields[0].v).toBe(100000000000n); // deposit
        expect(pp.fields[1].tag).toBe(1n); // return address: script credential (header 0xf0)
        expect(pp.fields[2].tag).toBe(2n); // TreasuryWithdrawals
    });
    test("the V3 TxInfo carries votes, proposals and the donation", () => {
        const info: any = ctx.txInfo(3);
        expect(info.fields.length).toBe(16);
        const votes = info.fields[12];
        expect(votes.entries.length).toBe(1);
        expect(votes.entries[0].snd.entries[0].snd.tag).toBe(1n); // VoteYes
        expect(info.fields[13].items.length).toBe(1);
        expect(info.fields[14].tag).toBe(1n); // no current treasury: Nothing
        expect(info.fields[15].tag).toBe(0n); // donation: Just 1000
        expect(info.fields[15].fields[0].v).toBe(1000n);
    });
    test("V1/V2 contexts reject Conway governance fields (VotingProceduresFieldNotSupported)", () => {
        expect(() => ctx.txInfo(2)).toThrow(ContextError);
        expect(() => ctx.txInfo(1)).toThrow(/VotingProceduresFieldNotSupported/);
        expect(() => ctx.purposeData(ctx.purposeOf({ tag: 4, index: 0 })!, 2)).toThrow(/PlutusPurposeNotSupported/);
    });
    test("V1/V2 contexts reject Conway certificates but keep the deposit forms of (un)registration", () => {
        const certBody = (cert: any) => Cbor.encode(new CborMap([{ k: u(0), v: new CborArray([]) }, { k: u(1), v: new CborArray([]) }, { k: u(2), v: u(1) }, { k: u(4), v: new CborArray([cert]) }])).toBuffer();
        const w0 = Cbor.encode(new CborMap([])).toBuffer();
        const regDeposit = new CborArray([u(7), new CborArray([u(1), h(28, 5)]), u(2000000)]);
        const voteDeleg = new CborArray([u(9), new CborArray([u(1), h(28, 5)]), new CborArray([u(2)])]);
        const c1 = new TxContext({ era: 7, pv: 10, bodyBytes: certBody(regDeposit), witnessSetBytes: w0, resolved: new Map(), slotToPosixMs: (s: bigint) => s });
        expect((c1.txInfo(2) as any).fields[5].items[0].tag).toBe(0n); // DCertDelegRegKey
        const v3cert: any = (c1.txInfo(3) as any).fields[5].items[0];
        expect(v3cert.tag).toBe(0n); // TxCertRegStaking cred (Just deposit) from protocol 10
        expect(v3cert.fields[1].tag).toBe(0n);
        const c9 = new TxContext({ era: 7, pv: 9, bodyBytes: certBody(regDeposit), witnessSetBytes: w0, resolved: new Map(), slotToPosixMs: (s: bigint) => s });
        expect(((c9.txInfo(3) as any).fields[5].items[0] as any).fields[1].tag).toBe(1n); // protocol 9 (bootstrap): Nothing
        const c2 = new TxContext({ era: 7, pv: 10, bodyBytes: certBody(voteDeleg), witnessSetBytes: w0, resolved: new Map(), slotToPosixMs: (s: bigint) => s });
        expect(() => c2.txInfo(2)).toThrow(/CertificateNotSupported/);
        expect((c2.txInfo(3) as any).fields[5].items[0].fields[1].tag).toBe(1n); // DelegVote (DRepAlwaysAbstain)
    });
    test("withdrawals are in the ledger's credential order: script credentials first", () => {
        const b = Cbor.encode(new CborMap([{ k: u(0), v: new CborArray([]) }, { k: u(1), v: new CborArray([]) }, { k: u(2), v: u(1) }, { k: u(5), v: new CborMap([
            { k: new CborBytes(Uint8Array.from([0xe0, ...new Uint8Array(28).fill(0x01)])), v: u(1) },
            { k: new CborBytes(Uint8Array.from([0xf0, ...new Uint8Array(28).fill(0x09)])), v: u(2) },
        ]) }])).toBuffer();
        const c = new TxContext({ era: 7, pv: 10, bodyBytes: b, witnessSetBytes: Cbor.encode(new CborMap([])).toBuffer(), resolved: new Map(), slotToPosixMs: (s: bigint) => s });
        const w = c.purposeOf({ tag: 3, index: 0 })!;
        expect(c.scriptHashOf(w)).toBe("09".repeat(28)); // redeemer 3:0 points at the script credential
    });
});

describe("bug 168: the slot→POSIX clock of the script context must be the node's network, whatever the job says", () => {
    // preview block 36613e98… (slot 124075124), rejected live by node 3036: its rules worker had been pinned to
    // preprod because the job carried config.network = "testnet" (src/config/preview/config.json) and
    // normalizeEpochNetwork maps unknown names to preprod. The V2 script derives a time-step count from the
    // validity range; 9.2 Ms in the past it looped and ran out of budget (cpu 855634542/585654985).
    const { job, input } = loadJob("plutus-preview-124075124-0.json");
    test("the block's transaction passes with preview's clock, spending exactly the declared units", () => {
        expect(job.blockHash).toBe("36613e9896432303e2d762ee122497e42b850f909650e0b6bed91e7f5b5d7f8c");
        const r = evaluatePhase2Sync({ ...input, network: "preview" });
        expect(r.error).toBeNull();
        expect(r.ok).toBe(true);
        expect(r.redeemers[0]!.spent).toEqual({ cpu: 585654985n, mem: 1874286n });
    });
    test("preprod's clock reproduces the live rejection (what a wrongly pinned worker computed)", () => {
        const r = evaluatePhase2Sync({ ...input, network: "preprod" });
        expect(r.ok).toBe(false);
        expect(r.redeemers[0]!.reason).toBe("budget exceeded");
        expect(r.redeemers[0]!.spent!.cpu).toBe(855634542n);
    });
    test("a network name the geometry table does not know (\"testnet\") keeps the active clock instead of preprod's", () => {
        setEpochNetwork("preview");
        expect(slotToPosixMs(124075095n, "testnet")).toBe(slotToPosixMs(124075095n, "preview"));
        expect(slotToPosixMs(124075095n, undefined)).toBe(1790731095000n);
        const r = evaluatePhase2Sync({ ...input, network: "testnet" });
        expect(r.ok).toBe(true);
    });
    test("a rules job naming \"testnet\" does not re-pin the worker's geometry", async () => {
        setEpochNetwork("preview");
        const { runBlockRulesJob } = await import("../workers/validationJob");
        await runBlockRulesJob({ kind: "blockRules", block: new Uint8Array([0x82, 0x00, 0x80]), slot: "1", params: null, genesis: null, config: { network: "testnet", networkMagic: 2 }, resolved: new Map(), pools: new Set(), rewardBalances: null } as any);
        expect(getEpochNetwork()).toBe("preview");
    });
});
