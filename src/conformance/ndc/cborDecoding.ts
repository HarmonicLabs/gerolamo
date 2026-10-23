/**
 * pragma-org node-diversity-conformance, scenario `cbor-decoding`: Gerolamo's production CBOR
 * decoders against the cardano-cbor-dataset corpus (`conway-123-100`, branch
 * `etorreborre/feat/normalization` of github.com/etorreborre/cardano-cbor-dataset).
 *
 * Corpus layout and semantics (dataset README, `app/Corpus.hs`):
 *   <rule>/valid/<n>.cbor           must decode; the re-encoding must equal <rule>/expected/<n>.cbor,
 *                                   after normalization (cborNormalize.ts) except for the hashed
 *                                   rules, where it must equal the original bytes exactly
 *   <rule>/invalid/zap-0/<n>.cbor   generator output the Haskell decoder rejects: must be rejected
 *   <rule>/invalid/zap-<k>/<n>.cbor mutations of severity k ≥ 1: must be rejected
 *
 * "The node's decoder" for each rule is the code path Gerolamo runs for that structure on the wire
 * or in a block: @harmoniclabs/cardano-ledger-ts (vendored, with its own nested @harmoniclabs/cbor
 * 2.x) for blocks, transactions and everything inside them; Gerolamo's `headerParser` for headers;
 * `parseMempoolTx` for whole transactions. A rule that the node only ever decodes inside a larger
 * structure is decoded with the same function the parent calls (`RULES[rule].path` names it), and
 * re-encoded with the same library's encoder. docs/parity/ndc-cbor-decoding.md has the mapping
 * and the failure analysis.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as LT from "@harmoniclabs/cardano-ledger-ts";
import { headerParser } from "../../consensus/blockHeaderParser";
import { parseMempoolTx } from "../../mempool/mempoolTx";
import { normalizeCbor } from "./cborNormalize";

// ───────────────────────────── library instances ─────────────────────────────

/**
 * The @harmoniclabs/cbor and plutus-data copies cardano-ledger-ts itself resolves (2.x, nested
 * under its node_modules). Gerolamo's root cbor is 1.6, and a CborObj from one copy is not an
 * `instanceof` the other's classes, so every `fromCborObj` call below gets objects parsed by the
 * library's own copy, exactly as the library's parent decoders hand them down.
 */
const ledgerRequire = createRequire(require.resolve("@harmoniclabs/cardano-ledger-ts"));
const LC: any = ledgerRequire("@harmoniclabs/cbor");
const PD: any = ledgerRequire("@harmoniclabs/plutus-data");
/** Deep modules the Conway decoders call that the package root shadows with an older copy. */
const conwayDrep: any = ledgerRequire("./eras/conway/governance/DRep/DRep.js");
const pparamsModule: any = ledgerRequire("./ledger/protocol/ProtocolParameters.js");
const L: any = LT;

export const LEDGER_TS_VERSION: string = ledgerRequire("../package.json").version;
export const LEDGER_CBOR_VERSION: string = createRequire(ledgerRequire.resolve("@harmoniclabs/cbor"))("../package.json").version;

function parseL(bytes: Uint8Array): any {
    return LC.Cbor.parse(bytes, { keepRef: true });
}

function asBytes(x: unknown): Uint8Array {
    if (x instanceof Uint8Array) return x;
    if (typeof x === "string") return new Uint8Array(Buffer.from(x, "hex"));
    if (x && typeof (x as any).toBuffer === "function") return asBytes((x as any).toBuffer());
    throw new Error(`encoder returned ${Object.prototype.toString.call(x)}, not bytes`);
}

function encodeL(obj: any): Uint8Array {
    return asBytes(LC.Cbor.encode(obj));
}

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
    const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let i = 0;
    for (const a of arrs) { out.set(a, i); i += a.length; }
    return out;
}

/** CBOR head of a byte string of length n. */
function bytesHead(n: number): number[] {
    if (n < 24) return [0x40 | n];
    if (n < 0x100) return [0x58, n];
    if (n < 0x10000) return [0x59, n >> 8, n & 0xff];
    return [0x5a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Value of key `k` in a library CborMap (re-encoded), or null. */
function mapEntryBytes(map: any, k: number): Uint8Array | null {
    if (!(map instanceof LC.CborMap)) throw new Error("encoder did not produce a map");
    const e = map.map.find((x: any) => x.k instanceof LC.CborUInt && Number(x.k.num) === k);
    return e ? encodeL(e.v) : null;
}

/** An enterprise testnet address (header 0x60 + 28 bytes): the carrier output's address. */
const CARRIER_ADDRESS = concat([0x58, 0x1d, 0x60], new Uint8Array(28).fill(0x11));
/** The native script `[5, 0]` (invalid_hereafter 0): the carrier output's script reference (datum_option). */
const CARRIER_SCRIPT = L.Script.fromCbor(Uint8Array.from([0x82, 0x00, 0x82, 0x05, 0x00]));

// ───────────────────────────── rule codecs ─────────────────────────────

export interface RuleCodec {
    /** The node's decode path for this structure (doc + report). */
    path: string;
    /** Throws when the node rejects the bytes. */
    decode(bytes: Uint8Array): unknown | Promise<unknown>;
    /** Re-encode with the same library's encoder. */
    encode(decoded: any, bytes: Uint8Array): Uint8Array;
}

/**
 * Rules whose bytes are a hash preimage (dataset README "Rules whose bytes are hashed",
 * `byteExactRuleNames` in app/LedgerRules.hs): no normalization, the re-encoding must reproduce the
 * original bytes.
 */
export const BYTE_EXACT_RULES: ReadonlySet<string> = new Set([
    "auxiliary_data", "header", "native_script", "plutus_data", "redeemers", "transaction_body", "transaction_witness_set",
]);

export const RULES: Record<string, RuleCodec> = {
    auxiliary_data: {
        path: "ConwayAuxiliaryData.fromCborObj (ConwayBlock auxiliary_data_set, ConwayTx)",
        decode: (b) => L.ConwayAuxiliaryData.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    block: {
        path: "blockParser → MultiEraBlock.fromCbor([7, block]) → ConwayBlock.fromCborObj",
        decode: (b) => {
            const mb = L.MultiEraBlock.fromCbor(concat([0x82, 0x07], b));
            if (Number(mb.era) !== 7) throw new Error(`decoded as era ${mb.era}`);
            return mb;
        },
        encode: (d) => asBytes(d.block.toCbor()),
    },
    certificate: {
        path: "ConwayTxBody key 4 → certificateFromCborObj (eras/common/ledger/certs/Certificate.js)",
        decode: (b) => L.certificateFromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    cost_models: {
        path: "ParameterChange → partialProtocolParametersFromCborObj key 18 → costModelsFromCborObj (cardano-costmodels-ts)",
        decode: (b) => pparamsModule.partialProtocolParametersFromCborObj(parseL(concat([0xa1, 0x12], b))),
        encode: (d) => {
            const cm = mapEntryBytes(pparamsModule.partialProtocolParametersToCborObj(d), 18);
            if (cm === null) throw new Error("the decoded protocol parameter update carries no cost models (key 18 was dropped by the decoder)");
            return cm;
        },
    },
    credential: {
        path: "Credential.fromCborObj (certificates, withdrawals, committee, voters)",
        decode: (b) => L.Credential.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    datum_option: {
        path: "ConwayTxOut.fromCborObj key 2 (inline in the output decoder; decoded through a carrier output)",
        decode: (b) => {
            const out = L.ConwayTxOut.fromCbor(concat([0xa3, 0x00], CARRIER_ADDRESS, [0x01, 0x01, 0x02], b));
            if (out.datum === undefined) throw new Error("datum dropped");
            return out;
        },
        encode: (d) => {
            // cardano-ledger re-encodes an output from its fields: with a datum hash and no script it is the
            // legacy array `[address, value, datum_hash]` (`TxOutCompactDH`), where the datum option has no
            // `[0, _]` wrapper of its own. The carrier output therefore carries a script reference too, so the
            // output takes the map form (`encodeTxOut`) and key 2 is the datum option as `EncCBOR (Datum era)`
            // emits it.
            const fresh = new L.ConwayTxOut({ address: d.address, value: d.value, datum: d.datum, refScript: CARRIER_SCRIPT });
            const v = mapEntryBytes(fresh.toCborObj(), 2);
            if (v === null) throw new Error("datum not re-encoded");
            return v;
        },
    },
    drep: {
        path: "drepFromCborObj (eras/conway/governance/DRep/DRep.js, as the Conway vote-delegation certificates call it)",
        decode: (b) => conwayDrep.drepFromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    gov_action: {
        path: "ProposalProcedure.fromCborObj → govActionFromCborObj (governance/govActionFromCborObj.js)",
        decode: (b) => L.govActionFromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    header: {
        path: "headerParser (src/consensus/blockHeaderParser.ts) on MsgRollForward [2, [6, #6.24(header)], tip] → ConwayHeader.fromCbor",
        decode: async (b) => {
            const tip = [0x82, 0x82, 0x00, 0x58, 0x20, ...new Array(32).fill(0), 0x00];
            const msg = concat([0x83, 0x02, 0x82, 0x06, 0xd8, 0x18], bytesHead(b.length), b, tip);
            const parsed = await headerParser(msg);
            if (!parsed) throw new Error("headerParser returned no header");
            return parsed.multiEraHeader.header;
        },
        encode: (d) => asBytes(d.toCbor()),
    },
    header_body: {
        path: "ConwayHeader.fromCborObj → ConwayHeaderBody.fromCborObj",
        decode: (b) => L.ConwayHeaderBody.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    native_script: {
        path: "ConwayTxWitnessSet key 1 → Script(NativeScript, Cbor.encode(item)); interpreted by Script.nativeScript() → nativeScriptFromCbor",
        decode: (b) => {
            const s = new L.Script(L.ScriptType.NativeScript, encodeL(parseL(b)));
            s.nativeScript();
            return s;
        },
        // the bytes the node hashes (0x00 ++ bytes) and writes back in the witness set
        encode: (d) => d.bytes,
    },
    plutus_data: {
        path: "ConwayTxWitnessSet key 4 / inline datum → dataFromCborObj (@harmoniclabs/plutus-data)",
        decode: (b) => PD.dataFromCborObj(parseL(b)),
        encode: (d) => asBytes(PD.dataToCbor(d)),
    },
    proposal_procedure: {
        path: "ConwayTxBody key 20 → ProposalProcedure.fromCborObj (governance/ProposalProcedure.js)",
        decode: (b) => L.ProposalProcedure.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    protocol_param_update: {
        path: "GovActionParameterChange → partialProtocolParametersFromCborObj (ledger/protocol/ProtocolParameters.js)",
        decode: (b) => pparamsModule.partialProtocolParametersFromCborObj(parseL(b)),
        encode: (d) => encodeL(pparamsModule.partialProtocolParametersToCborObj(d)),
    },
    redeemer: {
        path: "ConwayTxWitnessSet key 5 (list form) → ConwayTxRedeemer.fromCborObj",
        decode: (b) => L.ConwayTxRedeemer.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    redeemers: {
        path: "ConwayTxWitnessSet.fromCborObj key 5 → witnessRedeemersFromCborObj; re-encoded by ConwayTxWitnessSet.toCborObj key 5",
        decode: (b) => {
            const ws = L.ConwayTxWitnessSet.fromCbor(concat([0xa1, 0x05], b));
            if (ws.redeemers === undefined) throw new Error("redeemers dropped");
            return ws.redeemers;
        },
        encode: (d) => {
            const v = mapEntryBytes(new L.ConwayTxWitnessSet({ redeemers: d }).toCborObj(), 5);
            if (v === null) throw new Error("redeemers not re-encoded");
            return v;
        },
    },
    relay: {
        path: "PoolParams.fromCborObj → poolRelayFromCborObj (eras/common/ledger/PoolRelay.js)",
        decode: (b) => L.poolRelayFromCborObj(parseL(b)),
        encode: (d) => encodeL(L.poolRelayToCborObj(d)),
    },
    script: {
        path: "ConwayTxOut key 3 (#6.24 payload) → Script.fromCbor",
        decode: (b) => L.Script.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    transaction: {
        path: "parseMempoolTx (src/mempool/mempoolTx.ts, ValidatingMempool / LocalTxSubmit) → ConwayTx.fromCbor",
        decode: (b) => { parseMempoolTx(b); return L.ConwayTx.fromCbor(b); },
        encode: (d) => asBytes(d.toCbor()),
    },
    transaction_body: {
        path: "ConwayBlock transaction_bodies → ConwayTxBody.fromCborObj",
        decode: (b) => L.ConwayTxBody.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    transaction_input: {
        path: "ConwayTxBody keys 0/13/18 → TxOutRef.fromCborObj",
        decode: (b) => L.TxOutRef.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    transaction_output: {
        path: "ConwayTxBody key 1 → ConwayTxOut.fromCborObj",
        decode: (b) => L.ConwayTxOut.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    transaction_witness_set: {
        path: "ConwayBlock transaction_witness_sets → ConwayTxWitnessSet.fromCborObj",
        decode: (b) => L.ConwayTxWitnessSet.fromCbor(b),
        encode: (d) => asBytes(d.toCbor()),
    },
    value: {
        path: "ConwayTxOut key 1 → Value.fromCborObj (eras/common/ledger/Value/Value.js)",
        decode: (b) => L.Value.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
    voting_procedure: {
        path: "ConwayTxBody key 19 → VotingProcedures.fromCborObj → VotingProcedure.fromCborObj",
        decode: (b) => L.VotingProcedure.fromCborObj(parseL(b)),
        encode: (d) => asBytes(d.toCbor()),
    },
};

// ───────────────────────────── report ─────────────────────────────

export interface Outcome {
    generated_total: number;
    generated_decoded_reencoded_expected: number;
    generated_decoded_reencoded_actual: number;
    generated_must_be_rejected_expected: number;
    generated_must_be_rejected_actual: number;
    zap_must_be_rejected_expected: number;
    zap_must_be_rejected_actual: number;
}

export interface Failure { sample: string; rule: string; class: string; reason: string }

/** scenarios/cbor-decoding/schema.json; `implementation`, `successful` and `failures` are extras the schema leaves open. */
export interface CborDecodingReport {
    version: "1";
    scenario: "cbor-decoding";
    generated_at: string;
    implementation: Record<string, unknown>;
    corpus: string;
    protocol_version: string;
    successful: boolean;
    totals: Outcome;
    rules: Record<string, Outcome>;
    failures: Failure[];
}

/** Failure labels of the dataset's own report (app/Report.hs `failureKindLabel`). */
export const FAILURE_CLASS = {
    decodeFailed: "decoding failed",
    decodeSucceeded: "decoding succeeded but the sample must be rejected",
    referenceMismatch: "re-encoding differs from the cbor reference",
    byteExactMismatch: "re-encoding differs from the original bytes",
    referenceUnreadable: "the cbor reference is missing or unreadable",
    unsupported: "rule not supported by this implementation",
} as const;

export const emptyOutcome = (): Outcome => ({
    generated_total: 0,
    generated_decoded_reencoded_expected: 0,
    generated_decoded_reencoded_actual: 0,
    generated_must_be_rejected_expected: 0,
    generated_must_be_rejected_actual: 0,
    zap_must_be_rejected_expected: 0,
    zap_must_be_rejected_actual: 0,
});

/** Hex dumps in a failure reason are cut at this many bytes (the full sample is in the corpus). */
export const REASON_HEX_LIMIT = 4096;

function hexDump(b: Uint8Array): string {
    const h = Buffer.from(b.subarray(0, REASON_HEX_LIMIT)).toString("hex");
    return b.length > REASON_HEX_LIMIT ? `${h}… (${b.length} bytes, first ${REASON_HEX_LIMIT} shown)` : h;
}

function errText(e: unknown): string {
    const s = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

export type SampleCategory = { kind: "valid" } | { kind: "zap"; level: number };

export interface SampleResult { ok: boolean; class?: string; reason?: string }

/** Silence library console output (ledger-ts logs some decode failures) while `fn` runs. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { log: console.log, warn: console.warn, error: console.error, dir: console.dir, info: console.info, debug: console.debug };
    const noop = () => {};
    Object.assign(console, { log: noop, warn: noop, error: noop, dir: noop, info: noop, debug: noop });
    try { return await fn(); } finally { Object.assign(console, saved); }
}

/** One sample against its expectation. */
export async function checkSample(rule: string, bytes: Uint8Array, cat: SampleCategory, expected?: Uint8Array): Promise<SampleResult> {
    const codec = RULES[rule];
    // a rule with no node decoder is reported, never counted as met (none today)
    if (!codec) return { ok: false, class: FAILURE_CLASS.unsupported, reason: `${FAILURE_CLASS.unsupported}: ${rule}` };
    let decoded: unknown;
    try {
        decoded = await quiet(async () => codec.decode(bytes));
    } catch (e) {
        if (cat.kind === "zap" || expected === undefined) return { ok: true };
        return { ok: false, class: FAILURE_CLASS.decodeFailed, reason: `${FAILURE_CLASS.decodeFailed}\n\n${errText(e)}` };
    }
    if (cat.kind === "zap" || expected === undefined) {
        return { ok: false, class: FAILURE_CLASS.decodeSucceeded, reason: FAILURE_CLASS.decodeSucceeded };
    }
    let reser: Uint8Array;
    try {
        reser = await quiet(async () => codec.encode(decoded, bytes));
    } catch (e) {
        return { ok: false, class: FAILURE_CLASS.referenceMismatch, reason: `${FAILURE_CLASS.referenceMismatch}\n\nre-encoding failed: ${errText(e)}\n\nexpected\n\n${hexDump(expected)}\n\n` };
    }
    if (BYTE_EXACT_RULES.has(rule)) {
        if (!eq(reser, bytes)) {
            return { ok: false, class: FAILURE_CLASS.byteExactMismatch, reason: `${FAILURE_CLASS.byteExactMismatch}\n\nexpected\n\n${hexDump(bytes)}\n\ngot\n\n${hexDump(reser)}\n\n` };
        }
        if (!eq(reser, expected)) {
            return { ok: false, class: FAILURE_CLASS.referenceMismatch, reason: `${FAILURE_CLASS.referenceMismatch}\n\nexpected\n\n${hexDump(expected)}\n\ngot\n\n${hexDump(reser)}\n\n` };
        }
        return { ok: true };
    }
    let norm: Uint8Array;
    try {
        norm = normalizeCbor(reser);
    } catch (e) {
        return { ok: false, class: FAILURE_CLASS.referenceMismatch, reason: `${FAILURE_CLASS.referenceMismatch}\n\nthe re-encoding does not normalize: ${errText(e)}\n\nexpected\n\n${hexDump(expected)}\n\ngot\n\n${hexDump(reser)}\n\n` };
    }
    if (!eq(norm, expected)) {
        return { ok: false, class: FAILURE_CLASS.referenceMismatch, reason: `${FAILURE_CLASS.referenceMismatch}\n\nexpected\n\n${hexDump(expected)}\n\ngot\n\n${hexDump(norm)}\n\n` };
    }
    return { ok: true };
}

export interface RunOptions {
    /** Restrict to these rules (default: every rule directory in the corpus). */
    rules?: string[];
    implementation?: Record<string, unknown>;
    corpus?: string;
    protocolVersion?: string;
    /** Called once per finished rule. */
    onRule?: (rule: string, outcome: Outcome) => void;
}

const listCbor = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".cbor")).sort() : []);

/** Run every sample of the corpus directory (`.../dataset/conway-123-100`). */
export async function runCorpus(datasetDir: string, opts: RunOptions = {}): Promise<CborDecodingReport> {
    const ruleDirs = readdirSync(datasetDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const rules = opts.rules ? ruleDirs.filter((r) => opts.rules!.includes(r)) : ruleDirs;
    const out: Record<string, Outcome> = {};
    const failures: Failure[] = [];
    const totals = emptyOutcome();
    for (const rule of rules) {
        const o = emptyOutcome();
        const rdir = join(datasetDir, rule);
        for (const f of listCbor(join(rdir, "valid"))) {
            const stem = f.replace(/\.cbor$/, "");
            o.generated_total++;
            o.generated_decoded_reencoded_expected++;
            const bytes = new Uint8Array(readFileSync(join(rdir, "valid", f)));
            const expPath = join(rdir, "expected", f);
            let res: SampleResult;
            if (!existsSync(expPath)) res = { ok: false, class: FAILURE_CLASS.referenceUnreadable, reason: `${FAILURE_CLASS.referenceUnreadable}: ${expPath}` };
            else res = await checkSample(rule, bytes, { kind: "valid" }, new Uint8Array(readFileSync(expPath)));
            if (res.ok) o.generated_decoded_reencoded_actual++;
            else failures.push({ sample: `${rule}/valid/${stem}`, rule, class: res.class!, reason: res.reason! });
        }
        const inv = join(rdir, "invalid");
        const levels = existsSync(inv)
            ? readdirSync(inv).map((d) => /^zap-(\d+)$/.exec(d)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b)
            : [];
        for (const level of levels) {
            for (const f of listCbor(join(inv, `zap-${level}`))) {
                const stem = f.replace(/\.cbor$/, "");
                if (level === 0) { o.generated_total++; o.generated_must_be_rejected_expected++; }
                else o.zap_must_be_rejected_expected++;
                const bytes = new Uint8Array(readFileSync(join(inv, `zap-${level}`, f)));
                const res = await checkSample(rule, bytes, { kind: "zap", level });
                if (res.ok) {
                    if (level === 0) o.generated_must_be_rejected_actual++;
                    else o.zap_must_be_rejected_actual++;
                } else failures.push({ sample: `${rule}/invalid/zap-${level}/${stem}`, rule, class: res.class!, reason: res.reason! });
            }
        }
        out[rule] = o;
        for (const k of Object.keys(totals) as Array<keyof Outcome>) totals[k] += o[k];
        opts.onRule?.(rule, o);
    }
    return {
        version: "1",
        scenario: "cbor-decoding",
        generated_at: new Date().toISOString(),
        implementation: opts.implementation ?? { name: "gerolamo" },
        corpus: opts.corpus ?? "conway-123-100",
        protocol_version: opts.protocolVersion ?? "11.0",
        successful: failures.length === 0,
        totals,
        rules: out,
        failures,
    };
}

/** Met expectations / all expectations, the site's score. */
export function score(o: Outcome): { met: number; expected: number } {
    return {
        met: o.generated_decoded_reencoded_actual + o.generated_must_be_rejected_actual + o.zap_must_be_rejected_actual,
        expected: o.generated_decoded_reencoded_expected + o.generated_must_be_rejected_expected + o.zap_must_be_rejected_expected,
    };
}

// ───────────────────────────── schema check ─────────────────────────────

/**
 * Minimal JSON Schema (2020-12) check covering the keywords scenarios/cbor-decoding/schema.json
 * uses: type, const, required, properties, additionalProperties, items, oneOf, minimum, $ref
 * (local #/$defs), format date-time. Returns the list of violations (empty = valid).
 */
export function validateAgainstSchema(value: unknown, schema: any, root: any = schema, at = "$"): string[] {
    const errs: string[] = [];
    if (schema === true || schema === undefined) return errs;
    if (schema === false) return [`${at}: not allowed`];
    if (schema.$ref) {
        const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
        if (!m) return [`${at}: unsupported $ref ${schema.$ref}`];
        return validateAgainstSchema(value, root.$defs?.[m[1]!], root, at);
    }
    const typeOf = (v: unknown): string[] => {
        if (v === null) return ["null"];
        if (Array.isArray(v)) return ["array"];
        if (typeof v === "number") return Number.isInteger(v) ? ["integer", "number"] : ["number"];
        return [typeof v];
    };
    if (schema.type !== undefined) {
        const want: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!typeOf(value).some((t) => want.includes(t))) errs.push(`${at}: type ${typeOf(value)[0]}, expected ${want.join("|")}`);
    }
    if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errs.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) errs.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.format === "date-time" && typeof value === "string" && Number.isNaN(Date.parse(value))) errs.push(`${at}: not a date-time`);
    if (schema.oneOf) {
        const ok = schema.oneOf.filter((s: any) => validateAgainstSchema(value, s, root, at).length === 0).length;
        if (ok !== 1) errs.push(`${at}: matches ${ok} of oneOf, expected exactly 1`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const k of schema.required ?? []) if (!(k in obj)) errs.push(`${at}: missing required ${k}`);
        for (const [k, v] of Object.entries(obj)) {
            if (schema.properties && k in schema.properties) errs.push(...validateAgainstSchema(v, schema.properties[k], root, `${at}.${k}`));
            else if (schema.additionalProperties !== undefined) errs.push(...validateAgainstSchema(v, schema.additionalProperties, root, `${at}.${k}`));
        }
    }
    if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validateAgainstSchema(v, schema.items, root, `${at}[${i}]`)));
    return errs;
}

/** Report invariants the dataset README states on top of the schema. */
export function checkReportInvariants(r: CborDecodingReport): string[] {
    const errs: string[] = [];
    const sum = emptyOutcome();
    for (const [rule, o] of Object.entries(r.rules)) {
        if (o.generated_total !== o.generated_decoded_reencoded_expected + o.generated_must_be_rejected_expected) errs.push(`${rule}: generated_total is not the sum of the two generated expectations`);
        for (const k of Object.keys(sum) as Array<keyof Outcome>) sum[k] += o[k];
    }
    for (const k of Object.keys(sum) as Array<keyof Outcome>) if (sum[k] !== r.totals[k]) errs.push(`totals.${k} ${r.totals[k]} ≠ sum of rules ${sum[k]}`);
    const unmet = score(r.totals).expected - score(r.totals).met;
    if (unmet !== r.failures.length) errs.push(`${r.failures.length} failures listed for ${unmet} unmet expectations`);
    if (r.successful !== (r.failures.length === 0)) errs.push("successful disagrees with the failures");
    return errs;
}
