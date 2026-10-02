/**
 * A stored UTxO output as the Conway ledger serialises it (cardano-ledger-babbage `BabbageTxOut`
 * `encCBOR`): the compact forms keep the legacy array shape —
 *   no datum, no script      → [address, value]
 *   datum hash, no script    → [address, value, datum_hash]
 *   inline datum or a script → {0: address, 1: value, ?2: [0, hash] / [1, #6.24(datum)], ?3: #6.24(script_ref)}
 * whatever form the transaction wrote. Value = coin, or [coin, {policy: {name: qty}}] with keys in
 * byte order and the ledger's map-length rule.
 */
import { addressBytes } from "../utxoCbor";
import { CborWriter, hexBytes } from "./cborWriter";

export function ledgerTxOutBytes(json: Record<string, unknown>): Uint8Array | null {
    const w = new CborWriter(256);
    return writeLedgerTxOut(w, json) ? w.finish() : null;
}

/** Write the output into `w` (no intermediate buffer: GetUTxOWhole writes 3 M of them); false when the address is unreadable. */
export function writeLedgerTxOut(w: CborWriter, json: Record<string, unknown>): boolean {
    const addr = addressBytes(String(json.address ?? ""));
    if (!addr) return false;
    const inline = typeof json.inline_datum === "string" && json.inline_datum.length ? json.inline_datum : null;
    const dh = typeof json.datum_hash === "string" && json.datum_hash.length ? json.datum_hash : null;
    const script = typeof json.reference_script_cbor === "string" && json.reference_script_cbor.length ? json.reference_script_cbor : null;
    if (!inline && !script) {
        w.array(dh ? 3 : 2).bytes(addr);
        writeValue(w, String(json.amount ?? "0"), json.assets);
        if (dh) w.hex(dh);
        return true;
    }
    w.map(2 + (inline || dh ? 1 : 0) + (script ? 1 : 0)).uint(0).bytes(addr).uint(1);
    writeValue(w, String(json.amount ?? "0"), json.assets);
    if (inline) w.uint(2).array(2).uint(1).tag(24).bytes(hexBytes(inline));
    else if (dh) w.uint(2).array(2).uint(0).hex(dh);
    if (script) w.uint(3).tag(24).bytes(hexBytes(script));
    return true;
}

function writeValue(w: CborWriter, lovelace: string, assets: unknown): void {
    const coin = BigInt(lovelace || "0");
    const policies: Array<[string, Array<[string, bigint]>]> = [];
    if (assets && typeof assets === "object") {
        for (const [policy, names] of Object.entries(assets as Record<string, Record<string, string>>)) {
            if (!policy || !names || typeof names !== "object") continue;
            const inner = Object.entries(names).map(([n, q]) => [n.toLowerCase(), BigInt(q || "0")] as [string, bigint]).filter(([, q]) => q !== 0n).sort((a, b) => cmpHexBytes(a[0], b[0]));
            if (inner.length) policies.push([policy.toLowerCase(), inner]);
        }
    }
    if (!policies.length) { w.uint(coin); return; }
    policies.sort((a, b) => cmpHexBytes(a[0], b[0]));
    w.array(2).uint(coin);
    w.mapOf(policies, (p) => w.hex(p), (inner) => w.mapOf(inner, (n) => w.hex(n), (q) => w.int(q)));
}

/** Bytewise (ShortByteString) order of two hex strings: lexicographic, a prefix first. */
function cmpHexBytes(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
