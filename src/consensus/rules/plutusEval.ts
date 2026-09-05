/**
 * Plutus phase-2 shadow evaluation (report-only until it agrees over real history).
 *
 * Library copies: buildooor bundles its own cardano-ledger-ts (with its own
 * plutus-data and cbor); the root copies used by the block parser are different
 * classes, and `instanceof` checks on either side reject the other's objects.
 * So everything handed to buildooor (body, witness set, resolved UTxOs, datums)
 * is rebuilt from bytes with buildooor's classes, and everything handed to the
 * UPLC machine is converted to the root plutus-data copy through CBOR.
 */
import {
    AlonzoTxBody, BabbageTxBody, ConwayTxBody,
    AlonzoTxWitnessSet, BabbageTxWitnessSet, TxWitnessSet as ConwayTxWitnessSet,
    UTxO, TxOut, TxOutRef, Address, Value, Script, ScriptType, Hash32,
    dataFromCbor as bDataFromCbor, dataToCbor as bDataToCbor,
} from "@harmoniclabs/buildooor";
import { Machine, ExBudget } from "@harmoniclabs/plutus-machine";
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { costModelArrays, witnessDatumBytes, witnessScriptHashes, type PlutusLanguage } from "./scriptDataHash";
import { Application, ErrorUPLC, UPLCConst, UPLCDecoder } from "@harmoniclabs/uplc";
import { DataB, DataConstr, DataI, DataList, DataMap, DataPair, dataFromCbor, type Data } from "@harmoniclabs/plutus-data";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { getTxInfos } from "@harmoniclabs/buildooor/dist/toOnChain/getTxInfos.js";
import { getScriptInfoData, getSpendingPurposeData } from "@harmoniclabs/buildooor/dist/toOnChain/getSpendingPurposeData.js";
import type { EpochBodyParams } from "../epochParams";
import { shelleyStartSlot, slotToUnixTime } from "../../utils/epochFromSlotCalculations";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { utxoRefOf, ledgerInputs } from "./resolvedUtxo";
import { sortedInputRefs } from "./alonzoRules";

/**
 * Wall-clock cap per redeemer for the shadow (report-only): keeps heavy scripts
 * from stalling the sync. `GEROLAMO_PLUTUS_SHADOW_MS` overrides it (default 2000);
 * `GEROLAMO_PLUTUS_SHADOW_SAMPLE=n` evaluates only every n-th Plutus transaction.
 */
export const SHADOW_REDEEMER_WALL_MS = Math.max(50, Number(process.env.GEROLAMO_PLUTUS_SHADOW_MS ?? 2000) || 2000);
export const SHADOW_SAMPLE_EVERY = Math.max(1, Number(process.env.GEROLAMO_PLUTUS_SHADOW_SAMPLE ?? 1) || 1);
/**
 * Capacity limits of the JS evaluator. A redeemer declaring more CPU than
 * `GEROLAMO_PLUTUS_SHADOW_MAX_CPU` (default 3·10⁹) cannot finish within the
 * wall-clock cap and is skipped up front; a single builtin step costing more
 * than `GEROLAMO_PLUTUS_SHADOW_STEP_CPU` (default 2·10⁷, about two 160 KB
 * integers multiplied) is refused before it runs, because JavaScriptCore's
 * quadratic BigInt arithmetic would hold the main thread for minutes (preprod
 * slot 21835905: exponentiation by squaring, 9.3·10⁹ CPU declared).
 */
export const SHADOW_MAX_DECLARED_CPU = BigInt(Math.max(1, Number(process.env.GEROLAMO_PLUTUS_SHADOW_MAX_CPU ?? 3e9) || 3e9));
export const SHADOW_MAX_STEP_CPU = BigInt(Math.max(1, Number(process.env.GEROLAMO_PLUTUS_SHADOW_STEP_CPU ?? 2e7) || 2e7));
let shadowCounter = 0;

export interface ShadowEvalInput {
    era: number;
    body: any;
    witnessSet: any;
    /** Original bytes of the body and witness set (buildooor's classes are rebuilt from them). */
    bodyBytes?: Uint8Array | null;
    witnessSetBytes?: Uint8Array | null;
    resolved: Map<string, ResolvedUtxo>;
    params: EpochBodyParams | null;
    genesis: any;
    network: string;
    /** The block producer marked this tx as phase-2 invalid. */
    markedInvalid: boolean;
}

export interface ShadowEvalResult {
    evaluated: number;
    skipped: number;
    /** Set when the local verdict differs from the block's, or a script cannot be run. */
    mismatch: string | null;
}

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

function machinesFor(raw: Record<string, any>): Partial<Record<"v1" | "v2" | "v3", Machine>> {
    // `Machine` takes the cost model itself (array or named object); the arrays come
    // from whatever shape the parameter record stores (Blockfrost / genesis / update).
    const arrays = costModelArrays(raw);
    const out: Partial<Record<"v1" | "v2" | "v3", Machine>> = {};
    for (const [lang, k] of [[1, "v1"], [2, "v2"], [3, "v3"]] as const) {
        const m = arrays[lang];
        if (!m) continue;
        try {
            out[k] = new Machine(m as any);
        } catch {
            /* unusable cost model for this language */
        }
    }
    return out;
}

/**
 * Root-copy Data (what the UPLC machine expects) from any copy's Data object,
 * by structural clone (no CBOR round trip: the cbor copies warn on integers
 * beyond 64 bits and may not encode them alike).
 */
function toRootData(d: any): Data {
    const name = d?.constructor?.name ?? "";
    if (name === "DataI" || d?.int !== undefined) return new DataI(BigInt(d.int));
    if (name === "DataB" || d?.bytes !== undefined) {
        const b: any = d.bytes;
        const bytes: Uint8Array = b instanceof Uint8Array ? b : typeof b?.toBuffer === "function" ? b.toBuffer() : new Uint8Array(Buffer.from(String(b), "hex"));
        return new DataB(bytes);
    }
    if (name === "DataConstr" || d?.fields !== undefined) return new DataConstr(BigInt(d.constr), (d.fields as any[]).map(toRootData));
    if (name === "DataMap" || d?.map !== undefined) return new DataMap((d.map as any[]).map((e) => new DataPair(toRootData(e.fst), toRootData(e.snd))));
    if (name === "DataList" || d?.list !== undefined) return new DataList((d.list as any[]).map(toRootData));
    throw new Error(`unknown Data shape: ${name}`);
}

/** Strip every CBOR bytestring wrap around a Plutus script (some authors wrap twice). */
function flatScriptBytes(bytes: Uint8Array): Uint8Array {
    let cur = bytes;
    for (let i = 0; i < 4; i++) {
        try {
            const parsed = Cbor.parse(cur);
            if (parsed instanceof CborBytes) {
                cur = parsed.bytes;
                continue;
            }
        } catch {
            /* not CBOR: flat */
        }
        break;
    }
    return cur;
}

function refScriptParts(cborHex: string): { language: PlutusLanguage | null; bytes: Uint8Array } | null {
    try {
        const arr: any = Cbor.parse(Buffer.from(cborHex, "hex"));
        const lang = Number(arr?.array?.[0]?.num ?? NaN);
        const body = arr?.array?.[1];
        if (!(body instanceof CborBytes)) return null;
        return { language: lang === 1 || lang === 2 || lang === 3 ? (lang as PlutusLanguage) : null, bytes: body.bytes };
    } catch {
        return null;
    }
}

function toResolvedUtxo(input: any, u: ResolvedUtxo): UTxO | null {
    if (!u.address || !u.address.startsWith("addr")) return null; // Byron: not scriptable
    const addr = Address.fromString(u.address);
    const units = [...u.value].map(([unit, quantity]) => ({ unit, quantity }));
    const datum: any = u.inlineDatumCbor ? bDataFromCbor(u.inlineDatumCbor) : u.datumHash ? new Hash32(u.datumHash) : undefined;
    const refScript = u.referenceScriptCbor ? Script.fromCbor(u.referenceScriptCbor) : undefined;
    const ref = input.utxoRef ?? input;
    return new UTxO({
        utxoRef: new TxOutRef({ id: hex(ref.id), index: Number(ref.index) }),
        resolved: new TxOut({ address: addr, value: Value.fromUnits(units as any), datum, refScript }),
    });
}

function rebuildBody(era: number, bytes: Uint8Array): any {
    if (era >= 7) return ConwayTxBody.fromCbor(bytes);
    if (era === 6) return BabbageTxBody.fromCbor(bytes);
    return AlonzoTxBody.fromCbor(bytes);
}
function rebuildWitnessSet(era: number, bytes: Uint8Array): any {
    if (era >= 7) return ConwayTxWitnessSet.fromCbor(bytes);
    if (era === 6) return BabbageTxWitnessSet.fromCbor(bytes);
    return AlonzoTxWitnessSet.fromCbor(bytes);
}

export async function shadowEvaluateTx(input: ShadowEvalInput): Promise<ShadowEvalResult> {
    const redeemersRoot: any[] = input.witnessSet?.redeemers ?? [];
    if (redeemersRoot.length === 0) return { evaluated: 0, skipped: 0, mismatch: null };
    if (SHADOW_SAMPLE_EVERY > 1 && (shadowCounter++ % SHADOW_SAMPLE_EVERY) !== 0) return { evaluated: 0, skipped: 0, mismatch: null };
    const raw = input.params?.raw ?? {};
    const machines = machinesFor(raw);
    if (!machines.v1 && !machines.v2 && !machines.v3) return { evaluated: 0, skipped: redeemersRoot.length, mismatch: "no cost models in the epoch parameters" };
    if (!input.bodyBytes || !input.witnessSetBytes) return { evaluated: 0, skipped: redeemersRoot.length, mismatch: "original body/witness bytes unavailable" };

    let body: any, ws: any;
    try {
        body = rebuildBody(input.era, input.bodyBytes);
        ws = rebuildWitnessSet(input.era, input.witnessSetBytes);
    } catch (err) {
        return { evaluated: 0, skipped: redeemersRoot.length, mismatch: `buildooor could not decode the tx: ${err instanceof Error ? err.message : String(err)}` };
    }
    const redeemers: any[] = ws.redeemers ?? [];

    // resolved inputs (buildooor objects) layered over the rebuilt body
    const resolve = (list: any[]): UTxO[] | null => {
        const out: UTxO[] = [];
        for (const i of list ?? []) {
            const ref = utxoRefOf(i);
            const u = ref ? input.resolved.get(ref) : null;
            if (!u) return null;
            const r = toResolvedUtxo(i, u);
            if (!r) return null;
            out.push(r);
        }
        return out;
    };
    const inputs = resolve(ledgerInputs(body.inputs ?? [], input.era));
    const collateral = resolve(body.collateralInputs ?? []);
    const refInputs = resolve(body.refInputs ?? []);
    if (!inputs || !collateral || !refInputs) return { evaluated: 0, skipped: redeemers.length, mismatch: "an input could not be resolved for evaluation (Byron address or missing)" };
    const bodyLike = Object.create(body, {
        inputs: { value: inputs, enumerable: true },
        collateralInputs: { value: collateral.length ? collateral : undefined, enumerable: true },
        refInputs: { value: refInputs.length ? refInputs : undefined, enumerable: true },
    });
    const txLike = { body: bodyLike, witnesses: ws, isScriptValid: !input.markedInvalid };

    // Process-wide network geometry (the node's configured network), not a name lookup.
    const start = shelleyStartSlot();
    const genesisInfos = { systemStartPosixMs: Number(slotToUnixTime(start)) * 1000, slotLengthMs: 1000, startSlotNo: Number(start) };
    let infos: any;
    try {
        infos = getTxInfos(txLike as any, genesisInfos as any);
    } catch (err) {
        return { evaluated: 0, skipped: redeemers.length, mismatch: `script context failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // scripts by hash (hashes over the bytes as carried, see witnessScriptHashes) → flat program
    const scripts = new Map<string, { version: "v1" | "v2" | "v3"; flat: Uint8Array }>();
    for (const [h, w] of witnessScriptHashes(input.witnessSetBytes)) {
        if (w.kind !== "plutus" || !w.language) continue;
        scripts.set(h, { version: `v${w.language}` as "v1" | "v2" | "v3", flat: flatScriptBytes(w.bytes) });
    }
    for (const i of [...(body.inputs ?? []), ...(body.refInputs ?? [])] as any[]) {
        const ref = utxoRefOf(i);
        const u = ref ? input.resolved.get(ref) : null;
        if (!u?.referenceScriptCbor || !u.referenceScriptHash) continue;
        const parts = refScriptParts(u.referenceScriptCbor);
        if (parts?.language) scripts.set(u.referenceScriptHash.toLowerCase(), { version: `v${parts.language}` as "v1" | "v2" | "v3", flat: flatScriptBytes(parts.bytes) });
    }
    // witness datums by hash (original bytes)
    const datumBytes = new Map<string, Uint8Array>();
    for (const b of witnessDatumBytes(input.witnessSetBytes) ?? []) datumBytes.set(toHex(blake2b_256(b)), b);

    const sortedIns = sortedInputRefs(ledgerInputs(body.inputs ?? [], input.era));
    const policies = ((body.mint?.map ?? []) as any[]).map((e) => hex(e.policy)).filter(Boolean).sort();
    const certs: any[] = body.certs ?? [];
    const wdAccounts: any[] = ((body.withdrawals?.map ?? []) as any[]).map((w) => w.rewardAccount);

    let evaluated = 0, skipped = 0;
    let allValid = true;
    let failureNote: string | null = null;
    for (const r of redeemers) {
        const tag = Number(r.tag), idx = Number(r.index);
        let scriptHash = "";
        let datumCbor: Uint8Array | null = null;
        if (tag === 0) {
            const ref = sortedIns[idx];
            const u = ref ? input.resolved.get(ref) : null;
            const pcHash = u ? scriptHashOfAddress(u.address) : null;
            if (pcHash) scriptHash = pcHash;
            if (u?.inlineDatumCbor) datumCbor = Buffer.from(u.inlineDatumCbor, "hex");
            else if (u?.datumHash) datumCbor = datumBytes.get(u.datumHash.toLowerCase()) ?? null;
        } else if (tag === 1) scriptHash = policies[idx] ?? "";
        else if (tag === 2) scriptHash = hex((certs[idx]?.stakeCredential ?? certs[idx]?.drepCredential ?? certs[idx]?.coldCredential)?.hash);
        else if (tag === 3) scriptHash = hex(wdAccounts[idx]?.credentials?.hash ?? wdAccounts[idx]?.credentials);
        const script = scripts.get(scriptHash);
        if (!script) {
            skipped++;
            failureNote = failureNote ?? `script ${scriptHash.slice(0, 12) || "?"}… for redeemer ${tag}:${idx} not found`;
            continue;
        }
        const version = script.version;
        const machine = machines[version];
        if (!machine) {
            skipped++;
            failureNote = failureNote ?? `no cost model for Plutus ${version}`;
            continue;
        }
        const txInfo = version === "v1" ? infos.v1 : version === "v2" ? infos.v2 : infos.v3;
        if (!txInfo) {
            skipped++;
            failureNote = failureNote ?? `script context ${version} unavailable for this tx`;
            continue;
        }
        let term: any;
        try {
            const redeemerData = toRootData(r.data);
            const purpose = getSpendingPurposeData(r, bodyLike, version);
            const program = UPLCDecoder.parse(script.flat, "flat").body;
            if (version === "v3") {
                const bDatum = datumCbor ? bDataFromCbor(toHex(datumCbor)) : undefined;
                const info = getScriptInfoData(r, bodyLike, version, bDatum);
                const ctx = new DataConstr(0, [toRootData(txInfo), redeemerData, toRootData(info)]);
                term = new Application(program, UPLCConst.data(ctx));
            } else {
                const ctx = new DataConstr(0, [toRootData(txInfo), toRootData(purpose)]);
                let t: any = program;
                if (tag === 0) {
                    if (!datumCbor) {
                        skipped++;
                        failureNote = failureNote ?? `no datum for spend redeemer ${idx}`;
                        continue;
                    }
                    t = new Application(t, UPLCConst.data(dataFromCbor(toHex(datumCbor))));
                }
                t = new Application(t, UPLCConst.data(redeemerData));
                term = new Application(t, UPLCConst.data(ctx));
            }
        } catch (err) {
            skipped++;
            failureNote = failureNote ?? `context build failed: ${err instanceof Error ? err.message : String(err)}`;
            continue;
        }
        const declared = r.execUnits as ExBudget | undefined;
        if (declared && BigInt(declared.cpu) > SHADOW_MAX_DECLARED_CPU) {
            skipped++;
            failureNote = failureNote ?? `redeemer ${tag}:${idx} declares cpu ${declared.cpu}, beyond the shadow evaluator's capacity (${SHADOW_MAX_DECLARED_CPU})`;
            continue;
        }
        // Hard stop at the declared budget (vendored patch): a script the chain rejected
        // for running out of budget must not run on for ever here.
        // …and a wall-clock cap: the JS machine is orders of magnitude slower than the
        // reference, so a heavy (but valid) script is skipped rather than stalling the sync.
        // …and a per-step cap: one builtin on huge integers cannot be interrupted once started.
        (machine as any).maxBudget = declared
            ? { mem: BigInt(declared.mem), cpu: BigInt(declared.cpu), deadlineMs: Date.now() + SHADOW_REDEEMER_WALL_MS, maxStepCpu: SHADOW_MAX_STEP_CPU }
            : { mem: 1n << 62n, cpu: 1n << 62n, deadlineMs: Date.now() + SHADOW_REDEEMER_WALL_MS, maxStepCpu: SHADOW_MAX_STEP_CPU };
        let result: any, budgetSpent: any, overBudget = false;
        try {
            ({ result, budgetSpent } = machine.eval(term));
        } catch (err: any) {
            if (err?.timedOut) {
                skipped++;
                failureNote = failureNote ?? (err.stepTooLarge
                    ? `redeemer ${tag}:${idx} skipped: ${err.message}`
                    : `redeemer ${tag}:${idx} not finished within ${SHADOW_REDEEMER_WALL_MS} ms (cpu ${err.budgetSpent?.cpu}/${declared?.cpu})`);
                continue;
            }
            if (!err?.budgetExceeded) throw err;
            overBudget = true;
            budgetSpent = err.budgetSpent;
            result = null;
        }
        evaluated++;
        if (!overBudget && declared) overBudget = BigInt(budgetSpent.mem) > BigInt(declared.mem) || BigInt(budgetSpent.cpu) > BigInt(declared.cpu);
        if (result instanceof ErrorUPLC || overBudget) {
            allValid = false;
            failureNote = failureNote ?? (overBudget ? `redeemer ${tag}:${idx} exceeded its declared budget (mem ${budgetSpent.mem}/${declared?.mem}, cpu ${budgetSpent.cpu}/${declared?.cpu})` : `redeemer ${tag}:${idx} script error`);
        }
    }
    if (skipped > 0) return { evaluated, skipped, mismatch: `could not evaluate ${skipped} redeemer(s): ${failureNote}` };
    const expected = !input.markedInvalid;
    if (allValid !== expected) return { evaluated, skipped, mismatch: `local verdict ${allValid ? "valid" : "invalid"} ≠ block's ${expected ? "valid" : "invalid"}${failureNote ? ` (${failureNote})` : ""}` };
    return { evaluated, skipped, mismatch: null };
}

/** Script hash of a stored bech32 address's payment credential, or null when it is a key. */
function scriptHashOfAddress(address: string): string | null {
    try {
        const a: any = Address.fromString(address);
        const pc = a?.paymentCreds;
        const isScript = pc?.type === 1 || pc?.type === "script" || String(pc?.type).toLowerCase().includes("script");
        return isScript ? hex(pc.hash) : null;
    } catch {
        return null;
    }
}
