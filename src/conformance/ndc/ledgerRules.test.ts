/**
 * pragma-org node-diversity-conformance, scenario `ledger-rules` (docs/parity/ndc-ledger-rules.md).
 *
 * The corpus is not vendored: point `NDC_LEDGER_RULES_FIXTURES` at a checkout's
 * `scenarios/ledger-rules/fixtures` (or its `scenarios/` subdirectory) to run it; without it the
 * corpus test is skipped. The decoder tests always run.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CborArray, CborText, CborUInt } from "@harmoniclabs/cbor";
import { rejectMessageBytes, LedgerF, UtxoF, UtxowF, UtxosF, CertsF } from "../../mempool/applyTxErr";
import { applyTxErrBytesNames, applyTxErrNames, blockFailureName, corpusName, expectedOf, judge, ledgerResultEnum, loadFixtures, reportOf, runAll, unknownResults, type FixtureOutcome } from "./ledgerRules";
import { ledgerDefinitions, scoreLedgerRules } from "./ndcScore";
import { checkSchema } from "./uplcSchemaCheck";

/** The score reached on node-diversity-conformance 98cc462 (277 fixtures); the corpus test fails below it. */
const MIN_PASSED = 276;
/** Fixtures known not to conform, with the reason (docs/parity/ndc-ledger-rules.md). */
const KNOWN_FAILING = new Set(["00074"]); // empty input set: cardano-ledger-ts rejects the body at decoding

const FIXTURES = process.env.NDC_LEDGER_RULES_FIXTURES;
const haveCorpus = !!FIXTURES && existsSync(FIXTURES);

describe("ApplyTxErr → cardano-ledger constructor names", () => {
    test("nested UTXO / UTXOW / UTXOS / CERTS failures", () => {
        const names = applyTxErrNames([
            LedgerF.utxow(UtxowF.utxo(UtxoF.badInputs(["aa".repeat(32) + ":0"]))),
            LedgerF.utxow(UtxowF.missingVKeyWitnesses(["bb".repeat(28)])),
            LedgerF.utxow(UtxowF.utxo(UtxoF.utxos(UtxosF.validationTagPassedUnexpectedly()))),
            LedgerF.utxow(UtxowF.utxo(UtxoF.utxos(UtxosF.validationTagMismatch(true, [{ message: "x", context: new Uint8Array(0) }])))),
            LedgerF.certs(CertsF.deleg(CertsF.stakeKeyRegistered(0, "cc".repeat(28)))),
            LedgerF.certs(CertsF.withdrawalsNotInRewards([])),
            LedgerF.txRefScriptsSizeTooBig(300_000, 204_800),
            LedgerF.utxow(UtxowF.utxo(UtxoF.outsideForecast(500_000n))),
        ]);
        expect(names.map((n) => n.name)).toEqual([
            "BadInputsUTxO", "MissingVKeyWitnessesUTXOW", "ValidationTagMismatch", "ValidationTagMismatch", "StakeKeyRegisteredDELEG",
            "WithdrawalsNotInRewardsCERTS", "ConwayTxRefScriptsSizeTooBig", "OutsideForecast",
        ]);
        expect(names[2]!.description).toBe("PassedUnexpectedly");
        expect(names[3]!.description).toBe("FailedUnexpectedly");
    });

    test("MsgRejectTx bytes, and governance failures carried as MEMPOOL text", () => {
        const bytes = rejectMessageBytes([LedgerF.utxow(UtxowF.utxo(UtxoF.inputSetEmpty())), LedgerF.mempoolFailure("tx[0] 0123456789ab…: GOV VotersDoNotExist 2:aa")]);
        expect(applyTxErrBytesNames(bytes).map((n) => n.name)).toEqual(["InputSetEmptyUTxO", "VotersDoNotExist"]);
        const gov = applyTxErrNames([new CborArray([new CborUInt(3), new CborArray([new CborUInt(9)])])]);
        expect(gov[0]!.name).toBe("VotingOnExpiredGovAction");
        expect(applyTxErrNames([new CborArray([new CborUInt(7), new CborText("something else")])])[0]!.name).toBe("ConwayMempoolFailure");
    });

    test("block-rule texts", () => {
        expect(blockFailureName("tx[0]: spends 1 input(s) not in the UTxO set: aa:0").name).toBe("BadInputsUTxO");
        expect(blockFailureName("tx[0] 0123456789ab…: DELEG IncorrectDepositDELEG 0").name).toBe("IncorrectDepositDELEG");
        expect(blockFailureName("tx[0]: collateral -1000000 < required 1500000 (fee 1000000 × 150%)").name).toBe("InsufficientCollateral");
        expect(blockFailureName("tx[0]: OutputBootAddrAttrsTooBig: output 0 bootstrap address attributes 99 B > 64").name).toBe("OutputBootAddrAttrsTooBig");
    });

    test("corpus vocabulary and expectations", () => {
        expect(corpusName("MissingVKeyWitnessesUTXOW")).toBe("MissingVerificationKeyWitnessesUTXOW");
        expect(corpusName("InvalidPolicyHash")).toBe("InvalidGuardrailsScriptHash");
        expect(corpusName("BadInputsUTxO")).toBe("BadInputsUTxO");
        expect(expectedOf("Pass")).toEqual({ kind: "pass" });
        expect(expectedOf({ decoding_failure: true })).toEqual({ kind: "decoding" });
        expect(expectedOf({ predicate: "ValidationTagMismatch", description: "PassedUnexpectedly" })).toEqual({ kind: "fail", predicate: "ValidationTagMismatch", description: "PassedUnexpectedly" });
    });
});

describe("the report's result is the observed outcome", () => {
    const bad = { name: "BadInputsUTxO" }, missing = { name: "MissingVKeyWitnessesUTXOW" };
    test("accepted → pass, undecodable → DecodingFailure, rejected → the predicate (corpus vocabulary)", () => {
        expect(judge({ kind: "pass" }, { decoded: true, accepted: true, failures: [] })).toEqual({ conforms: true, result: "pass" });
        expect(judge({ kind: "fail", predicate: "BadInputsUTxO" }, { decoded: true, accepted: true, failures: [] })).toEqual({ conforms: false, result: "pass" });
        expect(judge({ kind: "decoding" }, { decoded: false, accepted: false, failures: [] })).toEqual({ conforms: true, result: "DecodingFailure" });
        expect(judge({ kind: "pass" }, { decoded: false, accepted: false, failures: [] })).toEqual({ conforms: false, result: "DecodingFailure" });
        expect(judge({ kind: "pass" }, { decoded: true, accepted: false, failures: [missing, bad] })).toEqual({ conforms: false, result: "MissingVerificationKeyWitnessesUTXOW" });
    });
    test("the expected predicate among several observed failures is the one reported; a description must agree", () => {
        expect(judge({ kind: "fail", predicate: "BadInputsUTxO" }, { decoded: true, accepted: false, failures: [missing, bad] })).toEqual({ conforms: true, result: "BadInputsUTxO" });
        expect(judge({ kind: "fail", predicate: "FeeTooSmallUTxO" }, { decoded: true, accepted: false, failures: [missing, bad] })).toEqual({ conforms: false, result: "MissingVerificationKeyWitnessesUTXOW" });
        const tag = (description: string) => ({ name: "ValidationTagMismatch", description });
        expect(judge({ kind: "fail", predicate: "ValidationTagMismatch", description: "PassedUnexpectedly" }, { decoded: true, accepted: false, failures: [tag("PassedUnexpectedly")] }).conforms).toBe(true);
        expect(judge({ kind: "fail", predicate: "ValidationTagMismatch", description: "PassedUnexpectedly" }, { decoded: true, accepted: false, failures: [tag("FailedUnexpectedly")] }).conforms).toBe(false);
    });
    test("report shape, result vocabulary check and the site's scoring agree with the verdicts", () => {
        const outcome = (id: string, result: string, conforms: boolean): FixtureOutcome => ({ id, expected: { kind: "pass" }, decoded: true, accepted: result === "pass", failures: [], result, conforms, details: { mempool: [], block: [], reports: [] } });
        const report = reportOf([outcome("00001", "pass", true), outcome("00002", "BadInputsUTxO", true), outcome("00003", "Unnamed", false)], { version: "v", commit: "c", corpus: "k", generatedAt: "2026-10-18T00:00:00Z" });
        expect(report.version).toBe("1");
        expect(report.totals).toEqual({ passed: 2, failed: 1, total: 3 });
        expect(report.scenarios).toEqual([{ id: "00001", result: "pass" }, { id: "00002", result: "BadInputsUTxO" }, { id: "00003", result: "Unnamed" }]);
        const schema = { properties: { scenarios: { items: { properties: { result: { oneOf: [{ const: "pass" }, { const: "BadInputsUTxO" }] } } } } } };
        expect(ledgerResultEnum(schema)).toEqual(new Set(["pass", "BadInputsUTxO"]));
        expect(unknownResults(report, ledgerResultEnum(schema)!)).toEqual([{ id: "00003", result: "Unnamed" }]);
        const s = scoreLedgerRules(report, [{ id: "00001", expected: "pass" }, { id: "00002", expected: "BadInputsUTxO" }, { id: "00003", expected: "pass" }]);
        expect([s.passed, s.total]).toEqual([2, 3]);
    });
});

describe.skipIf(!haveCorpus)("node-diversity-conformance ledger-rules corpus", () => {
    test(`at least ${MIN_PASSED} fixtures conform`, async () => {
        const fixtures = loadFixtures(FIXTURES!);
        const outcomes = await runAll(fixtures);
        const report = reportOf(outcomes, { version: "test", commit: "test", corpus: "test" });
        const failing = outcomes.filter((o) => !o.conforms).map((o) => `${o.id}: ${o.result}`);
        if (report.totals.passed < MIN_PASSED) console.log(failing.join("\n"));
        expect(report.totals.total).toBe(fixtures.length);
        expect(report.totals.passed).toBeGreaterThanOrEqual(MIN_PASSED);
        // nothing that conformed before regresses (a newly passing known failure is fine)
        expect(outcomes.filter((o) => !o.conforms && !KNOWN_FAILING.has(o.id)).map((o) => `${o.id}: ${o.result}`)).toEqual([]);
        for (const s of report.scenarios) expect(s.id).toMatch(/^\d{5}$/);
        // the site's scoring of the report equals our count of conforming fixtures
        const root = FIXTURES!.endsWith("scenarios") ? join(FIXTURES!, "..") : FIXTURES!;
        const site = scoreLedgerRules(report, ledgerDefinitions(root));
        expect(site.passed).toBe(report.totals.passed);
        const schemaPath = join(root, "../schema.json");
        if (existsSync(schemaPath)) {
            const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
            expect(checkSchema(schema, report)).toEqual([]);
            expect(unknownResults(report, ledgerResultEnum(schema)!)).toEqual([]);
        }
    }, 120_000);
});
