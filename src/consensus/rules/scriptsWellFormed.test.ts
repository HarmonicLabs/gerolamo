import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { encodeProgramFlat, parseProgram } from "../plutus/uplcText";
import { plutusScriptMalformed } from "./phase2";
import { checkScriptsWellFormed, outputPlutusRefScript } from "./scriptsWellFormed";
import type { WitnessScript } from "./scriptDataHash";

/** A Plutus script as the ledger carries it: the flat program inside one CBOR bytestring. */
const wrap = (flat: Uint8Array) => Cbor.encode(new CborBytes(flat)).toBuffer();
const script = (src: string) => wrap(encodeProgramFlat(parseProgram(src)));
const hashOf = (lang: number, bytes: Uint8Array) => { const p = new Uint8Array(1 + bytes.length); p[0] = lang; p.set(bytes, 1); return toHex(blake2b_224(p)); };
/** cardano-ledger's ImpSpec `malformedPlutus`: `PlutusBinary "invalid"`. */
const MALFORMED = new TextEncoder().encode("invalid");

/** A Babbage output map carrying `script` as its reference script. */
function outputWithRef(lang: number, bytes: Uint8Array): Uint8Array {
    const ref = Cbor.encode(new CborArray([new CborUInt(BigInt(lang)), new CborBytes(bytes)])).toBuffer();
    return Cbor.encode(new CborMap([
        { k: new CborUInt(0), v: new CborBytes(new Uint8Array(29).fill(0x60)) },
        { k: new CborUInt(1), v: new CborUInt(2_000_000) },
        { k: new CborUInt(3), v: new CborTag(24, new CborBytes(ref)) },
    ])).toBuffer();
}

describe("Babbage UTXOW validateScriptsWellFormed (bug 400)", () => {
    test("a malformed Plutus witness script fails MalformedScriptWitnesses (Blueprint UTXOW.MalformedScriptWitnesses)", () => {
        const wits = new Map<string, WitnessScript>([[hashOf(2, MALFORMED), { kind: "plutus", language: 2, bytes: MALFORMED }]]);
        const sink = { failures: [] as string[], reports: [] as string[] };
        checkScriptsWellFormed(sink, 7, 10, wits, []);
        expect(sink.failures).toHaveLength(1);
        expect(sink.failures[0]).toStartWith("MalformedScriptWitnesses: ");
    });

    test("a malformed reference script in an output fails MalformedReferenceScripts (Blueprint UTXOW.MalformedReferenceScripts)", () => {
        const sink = { failures: [] as string[], reports: [] as string[] };
        const out = outputWithRef(2, MALFORMED);
        expect(outputPlutusRefScript(out)!.hash).toBe(hashOf(2, MALFORMED));
        checkScriptsWellFormed(sink, 7, 10, new Map(), [out]);
        // "invalid" starts with 0x69: a 9-byte text string of which only 6 bytes follow — truncated CBOR, not a bytestring
        expect(sink.failures).toEqual([`MalformedReferenceScripts: ${hashOf(2, MALFORMED).slice(0, 12)}… (not CBOR: cbor: out of input)`]);
    });

    test("well-formed scripts pass; nothing is checked before Babbage", () => {
        const ok = script("(program 1.0.0 (lam d (lam r (lam c (con unit ())))))");
        const sink = { failures: [] as string[], reports: [] as string[] };
        checkScriptsWellFormed(sink, 7, 10, new Map([[hashOf(2, ok), { kind: "plutus", language: 2, bytes: ok }]]), [outputWithRef(2, ok)]);
        expect(sink.failures).toEqual([]);
        checkScriptsWellFormed(sink, 5, 6, new Map([[hashOf(1, MALFORMED), { kind: "plutus", language: 1, bytes: MALFORMED }]]), []);
        expect(sink.failures).toEqual([]);
    });

    test("deserialisation only: Plutus Core 1.1.0 in a V2 script at protocol 8 is well formed (preview slot 51809324 carries such reference scripts)", () => {
        const v110 = script("(program 1.1.0 (constr 0 (con integer 1)))");
        expect(plutusScriptMalformed(hashOf(2, v110), 2, 8, v110)).toBeNull();
        // ... while `constr` in a 1.0.0 program does not decode at all (UPLC flat decoder)
        const flat100 = encodeProgramFlat(parseProgram("(program 1.1.0 (constr 0 (con integer 1)))"));
        flat100[1] = 0; // the version's three naturals are the first three bytes: 1.1.0 → 1.0.0
        expect(plutusScriptMalformed(hashOf(2, wrap(flat100)), 2, 8, wrap(flat100))).toContain("constr needs Plutus Core 1.1.0");
    });

    test("builtins follow the language and protocol version; V3 rejects bytes after the script (RemainderError)", () => {
        // expModInteger (batch 6, flat tag 87) is a V3 builtin from protocol 11
        const em = script("(program 1.1.0 (builtin expModInteger))");
        expect(plutusScriptMalformed(hashOf(3, em), 3, 10, em)).toContain("not available");
        expect(plutusScriptMalformed(hashOf(3, em), 3, 11, em)).toBeNull();
        const ok = script("(program 1.1.0 (con integer 7))");
        const trailing = Uint8Array.of(...ok, 0x00);
        expect(plutusScriptMalformed(hashOf(3, trailing), 3, 10, trailing)).toContain("after the script bytestring");
        expect(plutusScriptMalformed(hashOf(2, trailing), 2, 10, trailing)).toBeNull(); // V1/V2 tolerate the remainder
        expect(plutusScriptMalformed(hashOf(3, ok), 3, 8, ok)).toContain("not available at protocol 8");
    });
});
