/**
 * False-rejection check for the validating mempool: every valid transaction of recent real
 * blocks must pass mempool admission when validated against the ledger just before its block.
 *
 * Blocks come from a Gerolamo node's immutable chunk store (read-only), inputs from its explorer
 * database (read-only: `mb_tx.body_cbor` of the creating transaction, so spent outputs, inline
 * datums and reference scripts are exact), protocol parameters and registered pools from a
 * node's LocalStateQuery (so only blocks of the current epoch are replayed). Stake-registration
 * checks are skipped (no historical state). Each transaction is validated on its own at its
 * block's slot, as a mempool at the previous tip would.
 *
 *   bun scripts/mempool-replay.ts --chunks <db/immutable> --explorer <preview.explorer.db> [--ref <node.socket>] [--last 3] [--plutus]
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Address, ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborArray, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { cborItemLength } from "../src/storage/chunkFormat";
import { openN2c } from "./lib/n2c";
import { lsqLedgerView } from "./lib/lsqLedgerView";
import { evaluateMempoolPhase1, txOutPartsFromBytes, type WitnessVerdict } from "../src/mempool/conwayMempoolRules";
import { parseMempoolTx } from "../src/mempool/mempoolTx";
import { collectShelleyWitnesses } from "../src/consensus/rules/witnesses";
import { runWitnessVerifyJob } from "../src/consensus/workers/witnessJob";
import { runMempoolPlutusJob } from "../src/mempool/plutusJob";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";
import { epochForSlot, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const has = (k: string) => process.argv.includes(`--${k}`);
const chunksDir = arg("chunks", "/media/bakon/data/cardano/gerolamo-preview-mithril2/db/immutable")!;
const explorer = new Database(arg("explorer", "/media/bakon/data/cardano/gerolamo-preview-mithril2/preview.explorer.db")!, { readonly: true });
const last = Number(arg("last", "3"));
const magic = Number(arg("magic", "2"));
const netName = magic === 2 ? "preview" : magic === 1 ? "preprod" : "mainnet";
setEpochNetwork(netName);
const c = await openN2c(arg("ref", "/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket")!, magic);
const view = await lsqLedgerView(c, magic === 764824073 ? "mainnet" : "testnet", netName);
const tip = (await view.tip())!;
const state = (await view.state(tip.slot + 1n))!;
const epoch = state.params.epoch;
const allPools = await (async () => { const s = new Set<string>(); return s; })();

// ── inputs: outputs indexed from the scanned blocks (exact bytes), else the explorer's mb_tx_out row
const outIndex = new Map<string, Uint8Array[]>(); // txid → output slices (copied)
const outStmt = explorer.query("SELECT address, lovelace, assets_json, datum_hash, inline_datum_cbor, script_ref_hash FROM mb_tx_out WHERE tx_hash = ? AND output_index = ?");
/** Item slices of the array stored under `key` of a CBOR map (definite forms). */
function mapValue(map: Uint8Array, key: number): Uint8Array[] | null {
    let p = 0; const n = head(map, p); p += n.len;
    for (let i = 0; i < n.count; i++) {
        const kl = cborItemLength(map, p); const k = Cbor.parse(map.subarray(p, p + kl)); p += kl;
        const vl = cborItemLength(map, p);
        if (k instanceof CborUInt && Number(k.num) === key) return items(map.subarray(p, p + vl));
        p += vl;
    }
    return null;
}
function head(b: Uint8Array, p: number): { count: number; len: number } {
    const ai = b[p]! & 31;
    if (ai < 24) return { count: ai, len: 1 };
    if (ai === 24) return { count: b[p + 1]!, len: 2 };
    if (ai === 25) return { count: (b[p + 1]! << 8) | b[p + 2]!, len: 3 };
    if (ai === 26) return { count: new DataView(b.buffer, b.byteOffset + p + 1, 4).getUint32(0), len: 5 };
    if (ai === 31) return { count: -1, len: 1 };
    throw new Error("unsupported length");
}
function items(arr: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []; const h = head(arr, 0); let p = h.len;
    const isMap = (arr[0]! >> 5) === 5;
    const count = h.count < 0 ? Infinity : h.count * (isMap ? 2 : 1);
    for (let i = 0; i < count && p < arr.length && arr[p] !== 0xff; i++) { const l = cborItemLength(arr, p); out.push(arr.subarray(p, p + l)); p += l; }
    return out;
}
function resolveRef(ref: string): ResolvedUtxo | null {
    const [id, ixs] = ref.split(":");
    const slice = outIndex.get(id!)?.[Number(ixs)];
    if (!slice) {
        const row = outStmt.get(id!, Number(ixs)) as any;
        if (!row || row.script_ref_hash) return null; // a reference script's bytes are not in the explorer row
        const value = new Map<string, bigint>([["lovelace", BigInt(row.lovelace)]]);
        try { for (const [pol, names] of Object.entries(JSON.parse(row.assets_json ?? "{}") as Record<string, Record<string, string>>)) if (pol) for (const [n, q] of Object.entries(names)) value.set(pol + n, BigInt(q)); } catch { /* */ }
        return { ref, address: row.address, value, referenceScriptHash: null, hasDatum: !!(row.datum_hash || row.inline_datum_cbor), datumHash: row.inline_datum_cbor ? null : row.datum_hash ?? null, inlineDatumCbor: row.inline_datum_cbor ?? null, referenceScriptCbor: null };
    }
    const parts = txOutPartsFromBytes(slice);
    let address = "";
    try { address = parts.address[0] === 0x82 ? (ByronAddress.fromBytes(parts.address) as any).toBase58() : Address.fromBytes(parts.address).toString(); } catch { address = ""; }
    let referenceScriptHash: string | null = null;
    if (parts.scriptRefCbor) {
        const sc = Cbor.parse(parts.scriptRefCbor) as CborArray;
        const lang = Number((sc.array[0] as CborUInt).num);
        const payload = lang === 0 ? Cbor.encode(sc.array[1]!).toBuffer() : (sc.array[1] as any).bytes as Uint8Array;
        const pre = new Uint8Array(1 + payload.length); pre[0] = lang; pre.set(payload, 1);
        referenceScriptHash = toHex(blake2b_224(pre));
    }
    return { ref, address, value: parts.value, referenceScriptHash, hasDatum: !!(parts.datumHash || parts.inlineDatumCbor), datumHash: parts.datumHash ?? null, inlineDatumCbor: parts.inlineDatumCbor ? toHex(parts.inlineDatumCbor) : null, referenceScriptCbor: parts.scriptRefCbor ? toHex(parts.scriptRefCbor) : null };
}

/** Conway blocks of a chunk / volatile file: slot and the raw transaction pieces. */
function* blocksOf(file: string): Generator<{ slot: bigint; bodies: Uint8Array[]; wits: Uint8Array[]; aux: Map<number, Uint8Array>; invalid: Set<number> }> {
    const bytes = new Uint8Array(readFileSync(file));
    let p = 0;
    while (p < bytes.length) {
        let len: number;
        try { len = cborItemLength(bytes, p); } catch { return; }
        const blk = bytes.subarray(p, p + len); p += len;
        const outer = items(blk);
        if (Number((Cbor.parse(outer[0]!) as CborUInt).num) !== 7) continue;
        const [hdr, bodiesA, witsA, auxM, invalidA] = items(outer[1]!) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
        const slot = BigInt((Cbor.parse(items(items(hdr)[0]!)[1]!) as CborUInt).num);
        const auxEntries = items(auxM);
        const aux = new Map<number, Uint8Array>();
        for (let i = 0; i + 1 < auxEntries.length; i += 2) aux.set(Number((Cbor.parse(auxEntries[i]!) as CborUInt).num), auxEntries[i + 1]!);
        const invalid = new Set(((Cbor.parse(invalidA) as CborArray).array ?? []).map((x: any) => Number(x.num)));
        yield { slot, bodies: items(bodiesA), wits: items(witsA), aux, invalid };
    }
}

// ── targets: the newest chunk files (+ the volatile files); sources for inputs: `--lookback` chunks before them too
const volDir = chunksDir.replace(/immutable\/?$/, "volatile");
const allChunks = readdirSync(chunksDir).filter((f) => f.endsWith(".chunk")).sort().map((f) => `${chunksDir}/${f}`);
const volatileFiles = has("volatile") ? readdirSync(volDir).filter((f) => f.endsWith(".dat")).sort().map((f) => `${volDir}/${f}`) : [];
const chunkFiles = [...allChunks.slice(-last), ...volatileFiles];
const sourceFiles = [...allChunks.slice(-(last + Number(arg("lookback", "300")))), ...volatileFiles];
for (const f of sourceFiles) for (const b of blocksOf(f)) for (const body of b.bodies) {
    const id = toHex(blake2b_256(body));
    const outs = mapValue(body, 1);
    if (outs) outIndex.set(id, outs.map((o) => Uint8Array.from(o)));
}
let blocks = 0, txs = 0, accepted = 0, skippedEpoch = 0, skippedInvalidFlag = 0, unresolved = 0, plutusRun = 0, plutusFailed = 0, plutusUnchecked = 0;
const rejects: string[] = [];
const plutusSamples: string[] = [];
const t0 = performance.now();
let phase1Ms = 0;
const seenTx = new Set<string>();
for (const f of chunkFiles) {
    for (const { slot, bodies, wits, aux, invalid } of blocksOf(f)) {
        blocks++;
        if (!has("any-epoch") && Number(epochForSlot(slot)) !== epoch) { skippedEpoch++; continue; }
        for (let i = 0; i < bodies.length; i++) {
            if (seenTx.has(toHex(blake2b_256(bodies[i]!)))) continue; // a volatile fork repeats a transaction
            seenTx.add(toHex(blake2b_256(bodies[i]!)));
            txs++;
            if (invalid.has(i)) { skippedInvalidFlag++; continue; }
            const a = aux.get(i) ?? new Uint8Array([0xf6]);
            const txBytes = new Uint8Array(1 + bodies[i]!.length + wits[i]!.length + 1 + a.length);
            txBytes[0] = 0x84; let q = 1;
            txBytes.set(bodies[i]!, q); q += bodies[i]!.length;
            txBytes.set(wits[i]!, q); q += wits[i]!.length;
            txBytes[q++] = 0xf5; txBytes.set(a, q);
            const tx = parseMempoolTx(txBytes);
            const resolved = new Map<string, ResolvedUtxo>();
            let missing = 0;
            for (const r of new Set([...tx.inputs, ...tx.collateral, ...tx.refInputs])) { const u = resolveRef(r); if (u) resolved.set(r, u); else missing++; }
            if (missing) { unresolved++; continue; }
            const w = collectShelleyWitnesses(tx.txIdBytes, tx.witnessSet);
            const ok = w.items.length ? runWitnessVerifyJob({ kind: "witnesses", items: w.items }).ok : [];
            const verdict: WitnessVerdict = { provenKeys: new Set(), provenRoots: new Set(), allKeyHashes: new Set(), invalidVkeys: [] };
            w.proves.forEach((pr, k) => { verdict.allKeyHashes.add(pr.hash); if (ok[k]) (pr.kind === "key" ? verdict.provenKeys : verdict.provenRoots).add(pr.hash); else if (pr.kind === "key") verdict.invalidVkeys.push(w.items[k]!.publicKey); });
            const poolIds = ((tx.body.certs ?? []) as any[]).filter((cc) => Number(cc.certType) === 3).map((cc) => String(cc.poolParams?.operator?.toString?.() ?? "").toLowerCase());
            const pools = await view.pools(poolIds);
            const tp = performance.now();
            const r = evaluateMempoolPhase1(tx, { ...state, slot }, { resolved, pools, rewardBalances: undefined, stake: null }, verdict);
            phase1Ms += performance.now() - tp;
            if (r.failures.length) { rejects.push(`slot ${slot} tx ${tx.txId.slice(0, 16)}: ${r.reasons.join("; ")}`); continue; }
            if (r.runsPlutus && has("plutus")) {
                plutusRun++;
                const pr = await runMempoolPlutusJob({ kind: "mempoolPlutus", tx: tx.bytes, bodyBytes: tx.bodyBytes, witnessSetBytes: tx.witnessSetBytes, resolved, params: state.params, genesis: state.genesis, network: state.network, epochNetwork: netName });
                if (pr.verdict === "failed") { plutusFailed++; if (plutusSamples.length < 10) plutusSamples.push(`slot ${slot} tx ${tx.txId.slice(0, 16)}: ${pr.detail}`); }
                if (pr.verdict === "unchecked") plutusUnchecked++;
            }
            accepted++;
        }
    }
}
console.log(`${chunkFiles.length} chunk(s), ${blocks} blocks (${skippedEpoch} outside epoch ${epoch}), ${txs} txs: ${accepted} accepted, ${rejects.length} REJECTED, ${skippedInvalidFlag} phase-2-invalid skipped, ${unresolved} with inputs the explorer lacks`);
if (has("plutus")) {
    console.log(`plutus: ${plutusRun} txs evaluated, ${plutusFailed} judged failing although on chain as valid, ${plutusUnchecked} unchecked`);
    for (const x of plutusSamples) console.log("  plutus disagreement " + x);
}
console.log(`phase 1: ${(phase1Ms / Math.max(1, accepted + rejects.length)).toFixed(2)} ms/tx; total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const r of rejects.slice(0, 30)) console.log("  " + r);
c.close();
process.exit(rejects.length ? 1 : 0);
