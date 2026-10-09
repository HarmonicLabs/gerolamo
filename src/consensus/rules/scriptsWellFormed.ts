/**
 * Babbage+ UTXOW `validateScriptsWellFormed` (cardano-ledger `Cardano.Ledger.Babbage.Rules.Utxow`):
 * every Plutus script in the witness set (`MalformedScriptWitnesses`) and every Plutus reference
 * script in the transaction's outputs and collateral return (`MalformedReferenceScripts`) must
 * deserialise for its language at the current protocol version (`validScript` →
 * `isValidPlutusScript` → plutus-ledger-api `deserialiseScript`). Native scripts are well formed
 * once the transaction decodes. Bug 400: no rule checked this, so a block carrying an output with an
 * undecodable reference script (Blueprint vector `BabbageImpSpec.UTXOW.MalformedReferenceScripts`)
 * was accepted, and an undecodable witness script only made phase 2 give no verdict.
 */
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { parseCbor } from "../plutus/cbor";
import { plutusScriptMalformed } from "./phase2";
import type { WitnessScript } from "./scriptDataHash";
import type { RuleSink } from "./ledgerChecks";

/** A Plutus reference script carried by an output: `3: #6.24(bytes .cbor [lang, bytes])` of a Babbage output map. */
export function outputPlutusRefScript(outputBytes: Uint8Array): { hash: string; language: 1 | 2 | 3; bytes: Uint8Array } | null {
    let o: ReturnType<typeof parseCbor>;
    try { o = parseCbor(outputBytes); } catch { return null; }
    if (o.t !== "m") return null;
    const ref = o.v.find(([k]) => k.t === "u" && k.v === 3n)?.[1];
    if (!ref || ref.t !== "tag" || ref.tag !== 24 || ref.v.t !== "b") return null;
    let s: ReturnType<typeof parseCbor>;
    try { s = parseCbor(ref.v.v); } catch { return null; }
    if (s.t !== "a" || s.v.length !== 2 || s.v[0]!.t !== "u" || s.v[1]!.t !== "b") return null;
    const lang = Number(s.v[0]!.v);
    if (lang < 1 || lang > 3) return null;
    const bytes = s.v[1]!.v as Uint8Array;
    const pre = new Uint8Array(1 + bytes.length);
    pre[0] = lang;
    pre.set(bytes, 1);
    return { hash: toHex(blake2b_224(pre)), language: lang as 1 | 2 | 3, bytes };
}

/**
 * `witnessScripts`: the witness set's scripts by hash (`witnessScriptHashes`); `outputs`: the
 * original bytes of each output and of the collateral return. No-op before Babbage or when the
 * protocol version is unknown.
 */
export function checkScriptsWellFormed(sink: RuleSink, era: number, pv: number | null, witnessScripts: ReadonlyMap<string, WitnessScript>, outputs: ReadonlyArray<Uint8Array | null>): void {
    if (era < 6 || pv == null) return;
    const badWits: string[] = [];
    for (const [hash, w] of witnessScripts) {
        if (w.kind !== "plutus" || w.language == null) continue;
        const why = plutusScriptMalformed(hash, w.language, pv, w.bytes);
        if (why) badWits.push(`${hash.slice(0, 12)}… (${why})`);
    }
    if (badWits.length) sink.failures.push(`MalformedScriptWitnesses: ${badWits.join(", ")}`);
    const badRefs: string[] = [];
    for (const b of outputs) {
        const r = b ? outputPlutusRefScript(b) : null;
        if (!r) continue;
        const why = plutusScriptMalformed(r.hash, r.language, pv, r.bytes);
        if (why) badRefs.push(`${r.hash.slice(0, 12)}… (${why})`);
    }
    if (badRefs.length) sink.failures.push(`MalformedReferenceScripts: ${badRefs.join(", ")}`);
}
