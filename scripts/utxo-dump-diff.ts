/**
 * Diff two saved GetUTxOWhole answers (`n2c-compare.ts --only GetUTxOWhole --huge --save <dir>`):
 *
 *   bun scripts/utxo-dump-diff.ts <dir>/7_GetUTxOWhole.ours.cbor <dir>/7_GetUTxOWhole.ref.cbor [--show 10]
 *
 * The answer is the LocalStateQuery result `[utxo-map]` with `utxo-map = { [txid, ix] => output }`. Keys are
 * compared as `txid#ix`; values as their raw CBOR bytes. Reports keys only on one side and keys whose output
 * bytes differ (with the first differing byte and a short decode of each side), plus a per-category summary.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborUInt, LazyCborArray, LazyCborObj } from "@harmoniclabs/cbor";
import { cborItemLength } from "../src/storage/chunkFormat";

const [oursPath, refPath] = process.argv.slice(2);
if (!oursPath || !refPath) { console.error("usage: utxo-dump-diff.ts <ours.cbor> <ref.cbor> [--show N]"); process.exit(2); }
const showArg = process.argv.indexOf("--show");
const SHOW = showArg > 0 ? Number(process.argv[showArg + 1]) : 10;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Walk the top-level `[ map ]` without materialising 3M CborObj values: returns key → raw value bytes. */
function entriesOf(bytes: Uint8Array): Map<string, Uint8Array> {
    const top = Cbor.parseLazy(bytes);
    if (!(top instanceof LazyCborArray) || top.array.length < 1) throw new Error("not a [utxo-map] result");
    const mapBytes = top.array[0]!;
    const out = new Map<string, Uint8Array>();
    // mapBytes is the raw bytes of the map item: read its header, then key/value items by length
    const h = mapBytes[0]! & 0x1f;
    let p = 1, n = -1;
    if (h < 24) n = h; else if (h === 24) { n = mapBytes[1]!; p = 2; } else if (h === 25) { n = (mapBytes[1]! << 8) | mapBytes[2]!; p = 3; }
    else if (h === 26) { n = new DataView(mapBytes.buffer, mapBytes.byteOffset + 1, 4).getUint32(0, false); p = 5; }
    else if (h === 27) { n = Number(new DataView(mapBytes.buffer, mapBytes.byteOffset + 1, 8).getBigUint64(0, false)); p = 9; }
    else if (h === 31) n = -1; // indefinite
    for (let i = 0; n < 0 ? mapBytes[p] !== 0xff : i < n; i++) {
        const kl = cborItemLength(mapBytes, p);
        const k = Cbor.parse(mapBytes.subarray(p, p + kl)) as CborArray;
        const txid = hex((k.array[0] as CborBytes).bytes), ix = Number((k.array[1] as CborUInt).num);
        p += kl;
        const vl = cborItemLength(mapBytes, p);
        out.set(`${txid}#${ix}`, mapBytes.subarray(p, p + vl));
        p += vl;
    }
    return out;
}

const t0 = performance.now();
const ours = entriesOf(new Uint8Array(await Bun.file(oursPath).arrayBuffer()));
const ref = entriesOf(new Uint8Array(await Bun.file(refPath).arrayBuffer()));
console.log(`ours ${ours.size} entries, ref ${ref.size} entries (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const onlyOurs: string[] = [], onlyRef: string[] = [], differ: string[] = [];
for (const k of ours.keys()) if (!ref.has(k)) onlyOurs.push(k);
for (const k of ref.keys()) if (!ours.has(k)) onlyRef.push(k);
for (const [k, v] of ours) { const r = ref.get(k); if (r && Buffer.compare(Buffer.from(v), Buffer.from(r)) !== 0) differ.push(k); }
console.log(`only ours: ${onlyOurs.length}; only ref: ${onlyRef.length}; same key, different output: ${differ.length}`);

const describe = (v: Uint8Array): string => {
    try {
        const o = Cbor.parse(v);
        if (o instanceof CborArray) return `legacy-array len ${o.array.length} addr ${hex((o.array[0] as CborBytes).bytes).slice(0, 24)}…`;
        if (o instanceof CborMap) {
            const keys = o.map.map((e) => Number((e.k as CborUInt).num));
            const addr = o.map.find((e) => Number((e.k as CborUInt).num) === 0)?.v as CborBytes | undefined;
            return `babbage-map keys [${keys.join(",")}] addr ${addr ? hex(addr.bytes).slice(0, 24) : "?"}…`;
        }
        return o.constructor.name;
    } catch (e) { return `undecodable: ${(e as Error).message}`; }
};
for (const k of onlyOurs.slice(0, SHOW)) console.log(`  only ours ${k}: ${describe(ours.get(k)!)}`);
for (const k of onlyRef.slice(0, SHOW)) console.log(`  only ref  ${k}: ${describe(ref.get(k)!)}`);
for (const k of differ.slice(0, SHOW)) {
    const a = ours.get(k)!, b = ref.get(k)!;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`  differ ${k}: ours ${a.length} B / ref ${b.length} B, first diff at ${i}\n    ours: ${describe(a)}\n    ref : ${describe(b)}\n    ours bytes: ${hex(a.subarray(Math.max(0, i - 8), i + 24))}\n    ref  bytes: ${hex(b.subarray(Math.max(0, i - 8), i + 24))}`);
}
// categories of the differing values
const cat = new Map<string, number>();
for (const k of differ) { const d = `${describe(ours.get(k)!).split(" ")[0]} vs ${describe(ref.get(k)!).split(" ")[0]}`; cat.set(d, (cat.get(d) ?? 0) + 1); }
if (cat.size) console.log("differ categories:", [...cat].map(([k, n]) => `${k}: ${n}`).join("; "));
