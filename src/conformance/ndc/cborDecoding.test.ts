/**
 * node-diversity-conformance `cbor-decoding` (cborDecoding.ts, docs/parity/ndc-cbor-decoding.md).
 *
 * Always: the shape normalizer against the dataset's 20 hand-checked vectors
 * (cardano-cbor-dataset `normalization-vectors/README.md`), the rational reduction of the README
 * table, and the report schema check.
 *
 * With GEROLAMO_NDC_CBOR_DATASET=<cardano-cbor-dataset>/dataset/conway-123-100 the whole corpus runs
 * through the production decoders and every rule must keep at least the score reached on
 * 2026-10-16 (ledger-ts 0.6.0-dijkstra.1+conformance.3, cbor 2.0.2+conformance.1: every
 * expectation met): a library upgrade may raise it, never lower it. Raise the floors when a fix lands.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { logger, LogLevel } from "../../utils/logger";
import { normalizeCbor } from "./cborNormalize";
import { checkReportInvariants, checkSample, runCorpus, score, validateAgainstSchema } from "./cborDecoding";

const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** normalization-vectors/README.md, rows 1–20 (in, out). */
const VECTORS: Array<[string, string, string]> = [
    ["indefinite-array", "9f0102ff", "820102"],
    ["indefinite-map", "bf0102ff", "a10102"],
    ["chunked-bytes", "5f420102420304ff", "4401020304"],
    ["chunked-text", "7f626162626364ff", "6461626364"],
    ["nested-indefinite", "9f9f01ffbf0102ffff", "828101a10102"],
    ["empty-indef-array", "9fff", "80"],
    ["empty-indef-map", "bfff", "a0"],
    ["non-minimal-int", "1805", "05"],
    ["unsorted-map-keys", "a202010102", "a202010102"],
    ["duplicate-map-keys", "a201020103", "a201020103"],
    ["uint-2^64-1", "1bffffffffffffffff", "1bffffffffffffffff"],
    ["tag-30-rational", "d81e820102", "d81e820102"],
    ["tag-259-map", "d90103a10102", "d90103a10102"],
    ["unknown-tag-1295", "d9050f01", "d9050f01"],
    ["tag-over-indefinite", "d81e9f0102ff", "d81e820102"],
    ["float16", "f93c00", "f93c00"],
    ["bignum-fits", "c24296be", "1996be"],
    ["negative-bignum-fits", "c3435e0f31", "3a005e0f31"],
    ["bignum-leading-zeros", "c2420000", "00"],
    ["bignum-too-large", "c249010000000000000000", "c249010000000000000000"],
];

/** Met expectations per rule on conway-123-100 (9 200 / 9 200 since ledger-ts 0.6.0-dijkstra.1+conformance.3). */
const FLOOR: Record<string, number> = {
    auxiliary_data: 400, block: 400, certificate: 400, cost_models: 100, credential: 200, datum_option: 400, drep: 200,
    gov_action: 400, header: 400, header_body: 400, native_script: 400, plutus_data: 400, proposal_procedure: 400,
    protocol_param_update: 400, redeemer: 400, redeemers: 400, relay: 400, script: 400, transaction: 400,
    transaction_body: 400, transaction_input: 300, transaction_output: 400, transaction_witness_set: 400, value: 400,
    voting_procedure: 400,
};
const FLOOR_TOTAL = 9200;

describe("ndc cbor-decoding: normalization", () => {
    for (const [name, input, output] of VECTORS) {
        test(name, () => expect(toHex(normalizeCbor(hex(input)))).toBe(output));
    }
    test("rationals are reduced, inside indefinite arrays too", () => {
        expect(toHex(normalizeCbor(hex("d81e820408")))).toBe("d81e820102");
        expect(toHex(normalizeCbor(hex("d81e9f0406ff")))).toBe("d81e820203");
        expect(toHex(normalizeCbor(hex("d81e820500")))).toBe("d81e820500"); // zero denominator: untouched
    });
    test("malformed input and trailing bytes throw", () => {
        expect(() => normalizeCbor(hex("8201"))).toThrow();
        expect(() => normalizeCbor(hex("0101"))).toThrow();
        expect(() => normalizeCbor(hex("ff"))).toThrow();
        expect(() => normalizeCbor(hex("5f4101610aff"))).toThrow(); // text chunk inside bytes
    });
});

describe("ndc cbor-decoding: harness", () => {
    test("a credential round-trips, a wrong rule shape is rejected", async () => {
        const cred = hex(`8200581c${"11".repeat(28)}`);
        expect((await checkSample("credential", cred, { kind: "valid" }, cred)).ok).toBe(true);
        expect((await checkSample("credential", hex("a0"), { kind: "zap", level: 1 })).ok).toBe(true);
    });
    test("an accepted mutation is a failure with the dataset's label", async () => {
        const r = await checkSample("credential", hex(`8200581c${"11".repeat(28)}`), { kind: "zap", level: 1 });
        expect(r.ok).toBe(false);
        expect(r.class).toBe("decoding succeeded but the sample must be rejected");
    });
    test("schema check", () => {
        const schema = {
            type: "object", required: ["a"], properties: { a: { const: "1" }, t: { oneOf: [{ type: "string", format: "date-time" }, { type: "integer", minimum: 0 }] } },
            additionalProperties: { $ref: "#/$defs/n" }, $defs: { n: { type: "integer", minimum: 0 } },
        };
        expect(validateAgainstSchema({ a: "1", t: "2026-10-15T00:00:00Z", x: 3 }, schema)).toEqual([]);
        expect(validateAgainstSchema({ a: "2", t: -1, x: -3 }, schema).length).toBe(3);
        expect(validateAgainstSchema({}, schema)).toEqual(["$: missing required a"]);
    });
});

const DATASET = process.env.GEROLAMO_NDC_CBOR_DATASET;
describe.skipIf(!DATASET || !existsSync(DATASET))("ndc cbor-decoding: conway-123-100 corpus", () => {
    test("no rule below its floor; report consistent and schema-valid", async () => {
        const level = logger.logLevel;
        logger.setLogLevel(LogLevel.NONE);
        try {
            const report = await runCorpus(DATASET!);
            expect(checkReportInvariants(report)).toEqual([]);
            const schemaPath = process.env.GEROLAMO_NDC_CBOR_SCHEMA;
            if (schemaPath && existsSync(schemaPath)) {
                expect(validateAgainstSchema(JSON.parse(JSON.stringify(report)), JSON.parse(readFileSync(schemaPath, "utf8")))).toEqual([]);
            }
            const below: string[] = [];
            for (const [rule, floor] of Object.entries(FLOOR)) {
                const o = report.rules[rule];
                if (!o) { below.push(`${rule}: missing`); continue; }
                const { met } = score(o);
                if (met < floor) below.push(`${rule}: ${met} < ${floor}`);
            }
            expect(below).toEqual([]);
            expect(score(report.totals).met).toBeGreaterThanOrEqual(FLOOR_TOTAL);
            expect(score(report.totals).expected).toBe(9200);
        } finally {
            logger.setLogLevel(level);
        }
    }, 120_000);
});
