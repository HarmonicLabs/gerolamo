/**
 * Offline phase-2 replay of a single transaction from a block (the repro harness).
 *
 *   bun scripts/phase2-repro.ts --block <file.hex> --tx <index> --resolved <file.json> \
 *       [--params <url|file>] [--network preprod] [--trace]
 *
 * `--resolved` is a JSON object keyed `txHashHex:outputIndex` holding ResolvedUtxo-shaped
 * entries; `value` may be a plain object ({ "lovelace": "123" }) and is converted to the
 * Map<string,bigint> the rules use. Reference scripts must be the ledger form
 * `[language, <script CBOR bytestring>]`, not just the script bytes.
 *
 * Exit code 0 when the verdict is ok, 1 when the transaction fails phase 2, 2 on a harness
 * error. Enable builtin tracing with --trace (or GEROLAMO_PLUTUS_BUILTIN_TRACE=1).
 *
 * Why it exists: Preprod block 5,386,017 tx[8] was rejected by the 74ea0d4 build with
 * "is_valid = true but redeemer 0:0 (V3) error term evaluated" and accepted by the chain.
 * bd385f2 (preprod systemStart is the genesis value) is the fix: the old slot geometry
 * shifted every TxInfo validity-range time by 86 400 slots x 20 s = 20 days, so a script
 * comparing a datum deadline against the validity range took its error branch.
 */
import { readFileSync } from "node:fs";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { checkBlockTxPhase2 } from "../src/consensus/rules/phase2";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";

interface Args { block: string; tx: number; resolved: string; params: string; network: string; trace: boolean }

function parseArgs(argv: string[]): Args {
    const out: Args = { block: "", tx: 0, resolved: "", params: "", network: "preprod", trace: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--block") out.block = argv[++i] ?? "";
        else if (a === "--tx") out.tx = Number(argv[++i] ?? 0);
        else if (a === "--resolved") out.resolved = argv[++i] ?? "";
        else if (a === "--params") out.params = argv[++i] ?? "";
        else if (a === "--network") out.network = argv[++i] ?? "preprod";
        else if (a === "--trace") out.trace = true;
    }
    if (!out.block || !out.resolved || !Number.isInteger(out.tx)) {
        console.error("usage: bun scripts/phase2-repro.ts --block <hex> --tx <i> --resolved <json> [--params <url|file>] [--network <net>] [--trace]");
        process.exit(2);
    }
    return out;
}

async function loadParams(spec: string, epoch: number): Promise<Record<string, unknown>> {
    if (!spec) throw new Error("--params is required (URL or JSON file of the epoch's parameters)");
    if (/^https?:/.test(spec)) return await (await fetch(spec)).json() as Record<string, unknown>;
    return JSON.parse(readFileSync(spec, "utf8")) as Record<string, unknown>;
}

function mapValue(v: unknown): Map<string, bigint> {
    const m = new Map<string, bigint>();
    if (v instanceof Map) for (const [k, q] of v as Map<string, unknown>) m.set(String(k), BigInt(String(q)));
    else if (v && typeof v === "object") for (const [k, q] of Object.entries(v as Record<string, unknown>)) m.set(k, BigInt(String(q)));
    return m;
}

const args = parseArgs(process.argv.slice(2));
if (args.trace) settingsTrace();

const blockBytes = new Uint8Array(Buffer.from(readFileSync(args.block, "utf8").trim(), "hex"));
const mb: any = MultiEraBlock.fromCbor(blockBytes);
const b: any = mb.block;
const era = Number(b.era ?? mb.era);
const bodies: any[] = b.transactionBodies ?? [];
const wits: any[] = b.transactionWitnessSets ?? [];
if (args.tx >= bodies.length) { console.error(`block has ${bodies.length} transactions, no index ${args.tx}`); process.exit(2); }

const body = bodies[args.tx];
const wit = wits[args.tx];
const bodyBytes: Uint8Array = body.cborRef?.toBuffer?.() ?? body.toCborBytes();
const witnessSetBytes: Uint8Array = wit?.cborRef?.toBuffer?.() ?? wit.toCborBytes();

const rawResolved = JSON.parse(readFileSync(args.resolved, "utf8")) as Record<string, any>;
const resolved = new Map<string, ResolvedUtxo>(
    Object.entries(rawResolved).map(([ref, v]) => [ref, { ...v, value: mapValue(v.value) } as ResolvedUtxo]),
);

const paramsJson = await loadParams(args.params, Number(b.epoch ?? 0));
const params = epochParamsFromRecord(Number(b.epoch ?? 0), paramsJson);

const verdict = checkBlockTxPhase2({
    era,
    bodyBytes,
    witnessSetBytes,
    resolved,
    params,
    markedInvalid: false,
    network: args.network,
} as any);
const json = JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
console.error(json);
process.exit(verdict.verdict.kind === "ok" ? 0 : 1);

/** Turn on the builtin trace through the settings layer, whatever the config file says. */
function settingsTrace(): void {
    process.env.GEROLAMO_PLUTUS_BUILTIN_TRACE = "1";
}
