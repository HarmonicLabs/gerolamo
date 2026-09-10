#!/usr/bin/env bun
/**
 * Structural diff of two Plutus Data values given as CBOR hex files (e.g. a script
 * context we built vs one built by another implementation).
 *   bun scripts/data-diff.ts a.hex b.hex [--max 40]
 */
import { dataFromCbor, DataConstr, DataMap, DataList, DataI, DataB } from "@harmoniclabs/plutus-data";
import { toHex } from "@harmoniclabs/uint8array-utils";
const [fa, fb] = process.argv.slice(2);
const max = Number(process.argv[process.argv.indexOf("--max") + 1] || 40);
const load = async (f: string) => dataFromCbor((await Bun.file(f).text()).trim());
const a = await load(fa), b = await load(fb);
let shown = 0;
const brief = (d: any): string => d instanceof DataI ? `I ${d.int}` : d instanceof DataB ? `B ${toHex(d.bytes.toBuffer?.() ?? d.bytes).slice(0, 24)}(${(d.bytes.toBuffer?.() ?? d.bytes).length})` : d instanceof DataConstr ? `Constr ${d.constr}[${d.fields.length}]` : d instanceof DataList ? `List[${d.list.length}]` : d instanceof DataMap ? `Map[${d.map.length}]` : String(d);
function diff(x: any, y: any, path: string) {
    if (shown >= max) return;
    const kx = x?.constructor?.name, ky = y?.constructor?.name;
    if (kx !== ky) { console.log(`${path}: ${brief(x)}  vs  ${brief(y)}`); shown++; return; }
    if (x instanceof DataI) { if (BigInt(x.int) !== BigInt(y.int)) { console.log(`${path}: I ${x.int} vs I ${y.int}`); shown++; } return; }
    if (x instanceof DataB) { const hx = toHex(x.bytes.toBuffer?.() ?? x.bytes), hy = toHex(y.bytes.toBuffer?.() ?? y.bytes); if (hx !== hy) { console.log(`${path}: B ${hx.slice(0, 40)} vs B ${hy.slice(0, 40)}`); shown++; } return; }
    if (x instanceof DataConstr) {
        if (BigInt(x.constr) !== BigInt(y.constr) || x.fields.length !== y.fields.length) { console.log(`${path}: ${brief(x)} vs ${brief(y)}`); shown++; if (x.fields.length !== y.fields.length) return; }
        x.fields.forEach((f: any, i: number) => diff(f, y.fields[i], `${path}.${x.constr}#${i}`)); return;
    }
    if (x instanceof DataList) {
        if (x.list.length !== y.list.length) { console.log(`${path}: List[${x.list.length}] vs List[${y.list.length}]`); shown++; }
        const n = Math.min(x.list.length, y.list.length);
        for (let i = 0; i < n; i++) diff(x.list[i], y.list[i], `${path}[${i}]`);
        for (let i = n; i < x.list.length; i++) console.log(`${path}[${i}]: only left: ${brief(x.list[i])}`);
        for (let i = n; i < y.list.length; i++) console.log(`${path}[${i}]: only right: ${brief(y.list[i])}`);
        return;
    }
    if (x instanceof DataMap) {
        if (x.map.length !== y.map.length) { console.log(`${path}: Map[${x.map.length}] vs Map[${y.map.length}]`); shown++; }
        const n = Math.min(x.map.length, y.map.length);
        for (let i = 0; i < n; i++) { diff(x.map[i].fst, y.map[i].fst, `${path}{${i}}.key`); diff(x.map[i].snd, y.map[i].snd, `${path}{${i}}.val`); }
        for (let i = n; i < x.map.length; i++) console.log(`${path}{${i}}: only left: ${brief(x.map[i].fst)} -> ${brief(x.map[i].snd)}`);
        for (let i = n; i < y.map.length; i++) console.log(`${path}{${i}}: only right: ${brief(y.map[i].fst)} -> ${brief(y.map[i].snd)}`);
        return;
    }
    console.log(`${path}: unknown kinds ${kx}/${ky}`); shown++;
}
diff(a, b, "ctx");
if (shown === 0) console.log("identical");
