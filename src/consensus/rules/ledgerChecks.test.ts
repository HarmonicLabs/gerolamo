import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborText, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import {
    BlockRefScriptSize, bootstrapAddressAttrsSize, certDepositsAndRefunds, checkAuxiliaryData, checkBadCollateralAndRefInputs, checkDisjointRefInputs, checkHeaderProtVer,
    checkOutputsTooBig, checkScriptWitnesses, checkSupplementalDatums, checkTreasuryValue, checkTxRefScriptsSize, checkValidityInterval, checkWithdrawalAccounts, checkWithdrawalsDelegated, invalidMetadatum,
    minFeeTx, newSink, rationalOf, refScriptOriginalSize, rewardAccountKey, scriptExecutionFee, serializedValueSize, tierRefScriptFeeExact, txRefScriptsSize,
} from "./ledgerChecks";

const TX = "ab".repeat(32);
const inp = (i: number, id = TX) => ({ utxoRef: { id, index: i } });
const KEY = "11".repeat(28), SCRIPT = "22".repeat(28);
/** `[2, h'<n bytes>']` wrapper as the UTxO stores a PlutusV2 reference script. */
const plutusWrapper = (n: number) => Buffer.from(Cbor.encode(new CborArray([new CborUInt(2), new CborBytes(new Uint8Array(n))])).toBuffer()).toString("hex");

describe("exact rationals and fees (bug 175)", () => {
    test("float prices read back as the chain's decimals", () => {
        expect(rationalOf(0.0577)).toEqual({ num: 577n, den: 10000n });
        expect(rationalOf(0.0000721)).toEqual({ num: 721n, den: 10000000n });
        expect(rationalOf(7.21e-7)).toEqual({ num: 721n, den: 1000000000n });
        expect(rationalOf("1/3")).toEqual({ num: 1n, den: 3n });
        expect(rationalOf({ numerator: 4, denominator: 8 })).toEqual({ num: 1n, den: 2n });
        expect(rationalOf(15)).toEqual({ num: 15n, den: 1n });
        expect(rationalOf(null)).toBeNull();
    });
    test("script fee is ⌈·⌉ of the exact sum: float arithmetic overshot by one at integer boundaries", () => {
        const pm = rationalOf(0.0577)!, ps = rationalOf(0.0000721)!;
        // 10 000·0.0577 + 430 000 000·0.0000721 = 577 + 31 003 exactly; Math.ceil of the doubles gave 31 581
        expect(Math.ceil(10000 * 0.0577 + 430000000 * 0.0000721)).toBe(31581);
        expect(scriptExecutionFee(10000n, 430000000n, pm, ps)).toBe(31580n);
        expect(scriptExecutionFee(1n, 0n, pm, ps)).toBe(1n);
        expect(scriptExecutionFee(0n, 0n, pm, ps)).toBe(0n);
    });
    test("tiered reference-script fee, exact and floored once", () => {
        const base = { num: 15n, den: 1n };
        expect(tierRefScriptFeeExact(0, base)).toBe(0n);
        expect(tierRefScriptFeeExact(25600, base)).toBe(384_000n);
        expect(tierRefScriptFeeExact(25601, base)).toBe(384_018n);
        expect(tierRefScriptFeeExact(81920, base)).toBe(1_530_470n);
        // 200 KiB = 8 full tiers: 384 000 · Σ₀⁷ 1.2^k = 6 335 648.5632 → floor
        expect(tierRefScriptFeeExact(204800, base)).toBe(6_335_648n);
        expect(tierRefScriptFeeExact(204800, { num: 30n, den: 2n })).toBe(6_335_648n);
    });
    test("minFeeTx adds the ref-script fee only in Conway", () => {
        const p = { minFeeA: 44n, minFeeB: 155381n, priceMem: rationalOf(0.0577), priceStep: rationalOf(0.0000721), refScriptCostPerByte: rationalOf(15) };
        const conway = minFeeTx(p, 7, 1000, { mem: 10000n, steps: 430000000n }, 1000);
        expect(conway).toEqual({ total: 44n * 1000n + 155381n + 31580n + 15000n, sizeFee: 199381n, scriptFee: 31580n, refScriptFee: 15000n });
        expect(minFeeTx(p, 6, 1000, { mem: 0n, steps: 0n }, 1000).total).toBe(199381n);
    });
});

describe("reference-script sizes (bugs 170, 171, 172)", () => {
    test("originalBytesSize counts the script bytes, never the [lang, bytes] wrapper", () => {
        expect(refScriptOriginalSize(plutusWrapper(10))).toBe(10);
        expect(refScriptOriginalSize(plutusWrapper(300))).toBe(300);
        expect(refScriptOriginalSize(plutusWrapper(70000))).toBe(70000);
        // native: `[0, script]`, the script's own CBOR
        const native = Buffer.from(Cbor.encode(new CborArray([new CborUInt(0), new CborArray([new CborUInt(0), new CborBytes(new Uint8Array(28))])])).toBuffer());
        expect(refScriptOriginalSize(native)).toBe(native.length - 2);
        expect(refScriptOriginalSize(null)).toBe(0);
    });
    test("an input listed as spent and referenced counts once; two inputs with one script count twice", () => {
        const u = new Map([[`${TX}:0`, { referenceScriptCbor: plutusWrapper(100) }], [`${TX}:1`, { referenceScriptCbor: plutusWrapper(100) }]]);
        expect(txRefScriptsSize({ inputs: [inp(0)], refInputs: [inp(0)] }, (r) => u.get(r))).toBe(100);
        expect(txRefScriptsSize({ inputs: [inp(0)], refInputs: [inp(1)] }, (r) => u.get(r))).toBe(200);
    });
    test("per-tx limit 200 KiB, Conway only", () => {
        const s = newSink();
        checkTxRefScriptsSize(s, 7, 204800);
        expect(s.failures).toEqual([]);
        checkTxRefScriptsSize(s, 7, 204801);
        checkTxRefScriptsSize(s, 6, 999999);
        expect(s.failures.length).toBe(1);
        expect(s.failures[0]).toStartWith("ConwayTxRefScriptsSizeTooBig");
    });
    test("block limit: up to protocol 10 against the block-start UTxO, from 11 earlier outputs count", () => {
        const start = new Map([[`${TX}:0`, { referenceScriptCbor: plutusWrapper(600_000) }]]);
        const child = "cd".repeat(32);
        const run = (pv: number) => {
            const acc = new BlockRefScriptSize(start, pv);
            acc.add({ inputs: [inp(5)], refInputs: [inp(0)] }, false, child, [{ referenceScriptCbor: plutusWrapper(500_000) }]);
            acc.add({ inputs: [inp(6)], refInputs: [inp(0, child)] }, false, "ef".repeat(32), []);
            const s = newSink();
            acc.check(s, 7);
            return { total: acc.total, s };
        };
        expect(run(10).total).toBe(600_000);
        expect(run(10).s.failures).toEqual([]);
        expect(run(11).total).toBe(1_100_000);
        expect(run(11).s.failures[0]).toStartWith("BodyRefScriptsSizeTooBig");
    });
});

describe("inputs (bugs 173, 174)", () => {
    test("inputs ∩ reference inputs fails for protocol 9 and 10 only", () => {
        const body = { inputs: [inp(0)], refInputs: [inp(0)] };
        for (const [pv, fails] of [[8, false], [9, true], [10, true], [11, false]] as const) {
            const s = newSink();
            checkDisjointRefInputs(s, body, pv, pv >= 9 ? 7 : 6);
            expect(s.failures.length > 0).toBe(fails);
        }
        const s = newSink();
        checkDisjointRefInputs(s, body, null, 7);
        expect(s.reports.length).toBe(1);
    });
    test("collateral (Alonzo+) and reference inputs (Babbage+) must exist", () => {
        const s = newSink();
        checkBadCollateralAndRefInputs(s, { collateralInputs: [inp(1)], refInputs: [inp(2)] }, 7, new Map([[`${TX}:1`, 1]]));
        expect(s.failures[0]).toContain(`${TX}:2`);
        const alonzo = newSink();
        checkBadCollateralAndRefInputs(alonzo, { collateralInputs: [inp(1)] }, 5, new Map());
        expect(alonzo.failures.length).toBe(1);
    });
});

describe("outputs (bugs 177, 178)", () => {
    test("serialised value size: bare coin, or [coin, {policy: {name: qty}}]", () => {
        expect(serializedValueSize(new Map([["lovelace", 1_000_000n]]))).toBe(5);
        expect(serializedValueSize(new Map([["lovelace", 23n]]))).toBe(1);
        // 82 1a(4) a1 581c(28) a1 44(4 name) 01  → 1+5+1+30+1+5+1
        expect(serializedValueSize(new Map([["lovelace", 1_000_000n], ["cc".repeat(28) + "01020304", 1n]]))).toBe(44);
        const big = new Map<string, bigint>([["lovelace", 2_000_000n]]);
        for (let i = 0; i < 200; i++) big.set("cc".repeat(28) + i.toString(16).padStart(8, "0").repeat(8), 1n);
        const s = newSink();
        checkOutputsTooBig(s, 7, 5000, [{ label: "output 0", units: big }]);
        expect(s.failures[0]).toStartWith("OutputTooBigUTxO");
        const pre = newSink();
        checkOutputsTooBig(pre, 4, 5000, [{ label: "output 0", units: big }]);
        expect(pre.failures).toEqual([]);
    });
    test("bootstrap address attributes: derivation-path payload + unknown attributes, magic excluded", () => {
        const byron = (attrs: CborMap) => {
            const payload = Cbor.encode(new CborArray([new CborBytes(new Uint8Array(28)), attrs, new CborUInt(0)])).toBuffer();
            return Cbor.encode(new CborArray([new CborTag(24, new CborBytes(payload)), new CborUInt(0)])).toBuffer();
        };
        const path = (n: number) => new CborBytes(Cbor.encode(new CborBytes(new Uint8Array(n))).toBuffer());
        const magic = new CborBytes(Cbor.encode(new CborUInt(2)).toBuffer());
        expect(bootstrapAddressAttrsSize(byron(new CborMap([])))).toBe(0);
        expect(bootstrapAddressAttrsSize(byron(new CborMap([{ k: new CborUInt(1), v: path(28) }, { k: new CborUInt(2), v: magic }])))).toBe(28);
        expect(bootstrapAddressAttrsSize(byron(new CborMap([{ k: new CborUInt(1), v: path(60) }, { k: new CborUInt(7), v: new CborBytes(new Uint8Array(5)) }])))).toBe(65);
        expect(bootstrapAddressAttrsSize(new Uint8Array([0x61, ...new Uint8Array(28)]))).toBeNull();
    });
});

describe("validity interval (bug 179)", () => {
    test("Shelley ttl is inclusive, Allegra+ upper bound exclusive", () => {
        const s2 = newSink(); checkValidityInterval(s2, 2, { ttl: 100n }, 100n); expect(s2.failures).toEqual([]);
        const s3 = newSink(); checkValidityInterval(s3, 3, { ttl: 100n }, 100n); expect(s3.failures[0]).toStartWith("expired");
        const s7 = newSink(); checkValidityInterval(s7, 7, { ttl: 101n, validityIntervalStart: 100n }, 100n); expect(s7.failures).toEqual([]);
        const s8 = newSink(); checkValidityInterval(s8, 7, { validityIntervalStart: 101n }, 100n); expect(s8.failures[0]).toStartWith("not yet valid");
    });
});

describe("certificate deposits and refunds (bug 176)", () => {
    const p = { keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, drepDeposit: 500_000_000n };
    const cred = { type: 0, hash: { toString: () => KEY } };
    test("a registration takes keyDeposit whatever its own field says", () => {
        expect(certDepositsAndRefunds([{ certType: 7, stakeCredential: cred, coin: 5_000_000n }], p, () => false)).toEqual({ deposits: 2_000_000n, refunds: 0n });
    });
    test("register then deregister in one tx refunds keyDeposit; otherwise the held deposit", () => {
        expect(certDepositsAndRefunds([{ certType: 7, stakeCredential: cred, coin: 2_000_000n }, { certType: 8, stakeCredential: cred, coin: 2_000_000n }], p, () => false)).toEqual({ deposits: 2_000_000n, refunds: 2_000_000n });
        expect(certDepositsAndRefunds([{ certType: 1, stakeCredential: cred }], p, () => false, () => 3_000_000n)).toEqual({ deposits: 0n, refunds: 3_000_000n });
        expect(certDepositsAndRefunds([{ certType: 1, stakeCredential: cred }], p, () => false, () => null).refunds).toBe(0n);
    });
    test("pool deposit once per new pool, DRep deposit from the parameter", () => {
        const pool = { certType: 3, poolParams: { operator: { toString: () => "aa".repeat(28) } } };
        expect(certDepositsAndRefunds([pool, pool], p, () => false).deposits).toBe(500_000_000n);
        expect(certDepositsAndRefunds([pool], p, () => true).deposits).toBe(0n);
        expect(certDepositsAndRefunds([{ certType: 16, coin: 1n }], p, () => false).deposits).toBe(500_000_000n);
        expect(certDepositsAndRefunds([{ certType: 17, coin: 400_000_000n }], p, () => false).refunds).toBe(400_000_000n);
    });
});

describe("Conway LEDGER withdrawals and treasury (bugs 180, 182)", () => {
    const wd = (type: "stakeKey" | "script", h: string) => ({ withdrawals: { map: [{ rewardAccount: { type, credentials: { toString: () => h } }, amount: 1n }] } });
    test("reward-account keys are typed from the address kind", () => {
        expect(rewardAccountKey({ type: "script", credentials: { toString: () => SCRIPT } })).toBe(`01${SCRIPT}`);
        expect(rewardAccountKey({ type: "stakeKey", credentials: { toString: () => KEY } })).toBe(KEY);
    });
    test("protocol ≥ 10: a key account must be DRep-delegated; scripts exempt; unknown reports", () => {
        const no = () => false;
        const s9 = newSink(); checkWithdrawalsDelegated(s9, wd("stakeKey", KEY), 7, 9, no); expect(s9.failures).toEqual([]);
        const s10 = newSink(); checkWithdrawalsDelegated(s10, wd("stakeKey", KEY), 7, 10, no); expect(s10.failures[0]).toStartWith("ConwayWdrlNotDelegatedToDRep");
        const ok = newSink(); checkWithdrawalsDelegated(ok, wd("stakeKey", KEY), 7, 11, () => true); expect(ok.failures).toEqual([]);
        const sc = newSink(); checkWithdrawalsDelegated(sc, wd("script", SCRIPT), 7, 11, no); expect(sc.failures).toEqual([]);
        const un = newSink(); checkWithdrawalsDelegated(un, wd("stakeKey", KEY), 7, 11, undefined); expect(un.failures).toEqual([]); expect(un.reports.length).toBe(1);
    });
    test("withdrawals need a registered account, judged before the tx's own certificates", () => {
        const body = { ...wd("stakeKey", KEY), certs: [{ certType: 1, stakeCredential: { type: 0, hash: { toString: () => KEY } } }] };
        const ok = newSink(); checkWithdrawalAccounts(ok, body, 6, () => true, true); expect(ok.failures).toEqual([]);
        const miss = newSink(); checkWithdrawalAccounts(miss, wd("stakeKey", KEY), 7, () => false, true); expect(miss.failures[0]).toStartWith("ConwayWithdrawalsMissingAccounts");
        const un = newSink(); checkWithdrawalAccounts(un, wd("stakeKey", KEY), 7, undefined, true); expect(un.reports.length).toBe(1);
    });
    test("current_treasury_value must equal the treasury; unknown treasury reports", () => {
        const s = newSink(); checkTreasuryValue(s, { currentTreasuryValue: 5n }, 6n, true); expect(s.failures[0]).toStartWith("ConwayTreasuryValueMismatch");
        const r = newSink(); checkTreasuryValue(r, { currentTreasuryValue: 5n }, null, true); expect(r.reports.length).toBe(1);
        const ok = newSink(); checkTreasuryValue(ok, { currentTreasuryValue: 5n }, 5n, true); expect(ok.failures).toEqual([]);
    });
});

describe("UTXOW scripts, datums, metadata (bugs 181, 183)", () => {
    test("Babbage+: a needed script available by reference must not also be a witness", () => {
        const s = newSink();
        checkScriptWitnesses(s, 7, new Set([SCRIPT]), new Set([SCRIPT]), new Set([SCRIPT]));
        expect(s.failures[0]).toStartWith("ExtraneousScriptWitnessesUTXOW");
        const alonzo = newSink();
        checkScriptWitnesses(alonzo, 5, new Set([SCRIPT]), new Set([SCRIPT]), new Set([SCRIPT]));
        expect(alonzo.failures).toEqual([]);
        const unneeded = newSink();
        checkScriptWitnesses(unneeded, 7, new Set(), new Set([SCRIPT]), new Set());
        expect(unneeded.failures[0]).toStartWith("ExtraneousScriptWitnessesUTXOW");
        const missing = newSink();
        checkScriptWitnesses(missing, 7, new Set([SCRIPT]), new Set(), new Set());
        expect(missing.failures[0]).toStartWith("MissingScriptWitnessesUTXOW");
    });
    test("a supplemental datum must match an output (or referenced output) datum hash", () => {
        const s = newSink();
        checkSupplementalDatums(s, new Set(["d1", "d2", "d3"]), new Set(["d1"]), new Set(["d2"]));
        expect(s.failures.length).toBe(1);
        expect(s.failures[0]).toContain("1 witness datum");
    });
    test("auxiliary data hash binding and 64-byte metadata", () => {
        const md = (text: string) => Cbor.encode(new CborMap([{ k: new CborUInt(674), v: new CborText(text) }])).toBuffer();
        const good = md("hello");
        const h = toHex(blake2b_256(good));
        const ok = newSink(); checkAuxiliaryData(ok, { auxDataHash: h }, good, 10); expect(ok.failures).toEqual([]);
        const bad = newSink(); checkAuxiliaryData(bad, { auxDataHash: "00".repeat(32) }, good, 10); expect(bad.failures[0]).toStartWith("ConflictingMetadataHash");
        const none = newSink(); checkAuxiliaryData(none, { auxDataHash: h }, null, 10); expect(none.failures[0]).toStartWith("MissingTxMetadata");
        const nohash = newSink(); checkAuxiliaryData(nohash, {}, good, 10); expect(nohash.failures[0]).toStartWith("MissingTxBodyMetadataHash");
        const long = md("x".repeat(65));
        const inv = newSink(); checkAuxiliaryData(inv, { auxDataHash: toHex(blake2b_256(long)) }, long, 10); expect(inv.failures[0]).toStartWith("InvalidMetadata");
        expect(invalidMetadatum(md("x".repeat(64)))).toBeNull();
        // Alonzo form: #6.259({0: metadata})
        const alonzo = Cbor.encode(new CborTag(259, new CborMap([{ k: new CborUInt(0), v: new CborMap([{ k: new CborUInt(1), v: new CborBytes(new Uint8Array(65)) }]) }]))).toBuffer();
        expect(invalidMetadatum(alonzo)).toContain("65");
        const unknown = newSink(); checkAuxiliaryData(unknown, { auxDataHash: h }, undefined, 10); expect(unknown.failures).toEqual([]);
    });
    test("header protocol version: mainnet only, at most one above the ledger's", () => {
        const s = newSink(); checkHeaderProtVer(s, 7, "mainnet", 12, 10); expect(s.failures.length).toBe(1);
        const t = newSink(); checkHeaderProtVer(t, 7, "testnet", 12, 10); expect(t.failures).toEqual([]);
        const ok = newSink(); checkHeaderProtVer(ok, 7, "mainnet", 11, 10); expect(ok.failures).toEqual([]);
    });
});
