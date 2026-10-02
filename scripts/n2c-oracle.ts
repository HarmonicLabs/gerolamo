/**
 * Node-to-client oracle: talk raw LocalStateQuery to a cardano-node socket and print the exact
 * CBOR of each reply, so our N2C hosts can mirror the reference encodings.
 *   bun scripts/n2c-oracle.ts --socket <node.socket> --magic <n> [--era 6] [--pool <hex>] [--out <dir>]
 */
import { connect } from "node:net";
import { Cbor, CborArray, CborUInt, CborMap, CborBytes, CborText, CborSimple, CborNegInt, CborTag } from "@harmoniclabs/cbor";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : []).filter((x) => x.length));
const sockPath = args.socket!, magic = Number(args.magic ?? 1), era = Number(args.era ?? 6);
const poolId = args.pool ?? "8df215df1a762e84d826bae39516a424a76e81e649001a3f903eda12"; // set-typed queries need one member
const sock = connect({ path: sockPath });
await new Promise<void>((r, j) => { sock.once("connect", () => r()); sock.once("error", j); });
const t0 = Date.now();
let inbox = new Uint8Array(0);
const waiters: Array<{ proto: number; resolve: (b: Uint8Array) => void }> = [];
const partial = new Map<number, Uint8Array[]>();
sock.on("data", (chunk: Buffer) => {
    const joined = new Uint8Array(inbox.length + chunk.length); joined.set(inbox); joined.set(chunk, inbox.length); inbox = joined;
    while (inbox.length >= 8) {
        const dv = new DataView(inbox.buffer, inbox.byteOffset, inbox.byteLength);
        const protoField = dv.getUint16(4), len = dv.getUint16(6);
        if (inbox.length < 8 + len) break;
        const proto = protoField & 0x7fff, payload = inbox.slice(8, 8 + len); inbox = inbox.slice(8 + len);
        const acc = partial.get(proto) ?? []; acc.push(payload);
        const all = Buffer.concat(acc.map((p) => Buffer.from(p)));
        try { Cbor.parse(all); partial.delete(proto); const w = waiters.findIndex((x) => x.proto === proto); if (w >= 0) waiters.splice(w, 1)[0]!.resolve(new Uint8Array(all)); }
        catch { partial.set(proto, acc); }
    }
});
function send(proto: number, payload: Uint8Array) {
    for (let off = 0; off < payload.length; off += 12288) {
        const part = payload.subarray(off, Math.min(payload.length, off + 12288));
        const h = Buffer.alloc(8); h.writeUInt32BE((Date.now() - t0) & 0xffffffff, 0); h.writeUInt16BE(proto, 4); h.writeUInt16BE(part.length, 6);
        sock.write(Buffer.concat([h, Buffer.from(part)]));
    }
}
const recv = (proto: number) => new Promise<Uint8Array>((resolve) => waiters.push({ proto, resolve }));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function show(o: any): any {
    if (o instanceof CborArray) return o.array.map(show);
    if (o instanceof CborMap) return Object.fromEntries(o.map.map((e: any) => [JSON.stringify(show(e.k)), show(e.v)]));
    if (o instanceof CborUInt) return o.num.toString();
    if (o instanceof CborNegInt) return o.num.toString();
    if (o instanceof CborBytes) return "h'" + hex(o.bytes).slice(0, 24) + (o.bytes.length > 12 ? "…" : "") + "'";
    if (o instanceof CborText) return JSON.stringify(o.text);
    if (o instanceof CborTag) return { tag: Number(o.tag), data: show(o.data) };
    if (o instanceof CborSimple) return String(o.simple);
    return String(o);
}
// handshake (N2C v15+: versionData = [magic, query]); propose 16..19
const table = new CborMap([19, 20, 21, 22, 23].map((v) => ({ k: new CborUInt(0x8000 | v), v: new CborArray([new CborUInt(magic), new CborSimple(false)]) })));
send(0, Cbor.encode(new CborArray([new CborUInt(0), table])).toBuffer());
const hs = Cbor.parse(await recv(0)) as CborArray;
console.log("handshake:", JSON.stringify(show(hs)));
// LSQ (protocol 7): acquire the volatile tip [8]
send(7, Cbor.encode(new CborArray([new CborUInt(8)])).toBuffer());
console.log("acquire →", JSON.stringify(show(Cbor.parse(await recv(7)))));
const queries: Array<[string, any]> = [
    ["GetSystemStart [1]", [1]],
    ["GetChainBlockNo [2]", [2]],
    ["GetChainPoint [3]", [3]],
    ["QueryHardFork GetCurrentEra [0,[2,[1]]]", [0, [2, [1]]]],
    ["QueryHardFork GetInterpreter [0,[2,[0]]]", [0, [2, [0]]]],
    [`QueryIfCurrent era${era} GetEpochNo [0,[0,[${era},[1]]]]`, [0, [0, [era, [1]]]]],
    [`QueryIfCurrent era${era} GetLedgerTip [0,[0,[${era},[0]]]]`, [0, [0, [era, [0]]]]],
    [`QueryIfCurrent era${era} GetCurrentPParams [0,[0,[${era},[3]]]]`, [0, [0, [era, [3]]]]],
    [`QueryIfCurrent era${era} GetGenesisConfig [0,[0,[${era},[11]]]]`, [0, [0, [era, [11]]]]],
    [`QueryIfCurrent era${era} GetStakePools [0,[0,[${era},[16]]]]`, [0, [0, [era, [16]]]]],
    [`QueryIfCurrent WRONG era${era - 1} GetEpochNo (mismatch)`, [0, [0, [era - 1, [1]]]]],
    [`QueryIfCurrent era${era} GetStakeDistribution [0,[0,[${era},[5]]]]`, [0, [0, [era, [5]]]]],
    [`QueryIfCurrent era${era} GetStakePoolParams [0,[0,[${era},[17,set(pool)]]]]`, [0, [0, [era, [17, new CborTag(258, new CborArray([new CborBytes(Uint8Array.from(Buffer.from(poolId, "hex")))]))]]]]],
    [`QueryIfCurrent era${era} GetPoolDistr [0,[0,[${era},[21,set(pool)]]]]`, [0, [0, [era, [21, new CborArray([new CborTag(258, new CborArray([new CborBytes(Uint8Array.from(Buffer.from(poolId, "hex")))]))])]]]]],
    [`QueryIfCurrent era${era} GetStakeSnapshots [0,[0,[${era},[20,set(pool)]]]]`, [0, [0, [era, [20, new CborArray([new CborTag(258, new CborArray([new CborBytes(Uint8Array.from(Buffer.from(poolId, "hex")))]))])]]]]],
    [`QueryIfCurrent era${era} GetConstitution [0,[0,[${era},[23]]]]`, [0, [0, [era, [23]]]]],
    [`QueryIfCurrent era${era} GetGovState [0,[0,[${era},[24]]]]`, [0, [0, [era, [24]]]]],
    [`QueryIfCurrent era${era} GetAccountState [0,[0,[${era},[29]]]]`, [0, [0, [era, [29]]]]],
    [`QueryIfCurrent era${era} GetFuturePParams [0,[0,[${era},[33]]]]`, [0, [0, [era, [33]]]]],
    [`QueryIfCurrent era${era} GetRewardInfoPools [0,[0,[${era},[18]]]]`, [0, [0, [era, [18]]]]],
    [`QueryIfCurrent era${era} GetProposedPParamsUpdates [0,[0,[${era},[4]]]]`, [0, [0, [era, [4]]]]],
];
const outDir = args.out; // write every reply's full hex + decoded JSON here
if (outDir) await import("node:fs/promises").then((fs) => fs.mkdir(outDir, { recursive: true }));
let qIndex = 0;
const toCbor = (v: any): any => Array.isArray(v) ? new CborArray(v.map(toCbor)) : typeof v === "number" ? new CborUInt(v) : v; // CborObj instances pass through
for (const [name, q] of queries) {
    send(7, Cbor.encode(new CborArray([new CborUInt(3), toCbor(q)])).toBuffer());
    const raw = await recv(7);
    const parsed = Cbor.parse(raw);
    const s = JSON.stringify(show(parsed));
    console.log(`\n### ${name}\nhex(${raw.length}): ${hex(raw).slice(0, 160)}${raw.length > 80 ? "…" : ""}\n${s.slice(0, 700)}${s.length > 700 ? " …" : ""}`);
    if (outDir) {
        const base = `${outDir}/${String(qIndex++).padStart(2, "0")}-${name.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 60)}`;
        await Bun.write(`${base}.hex`, hex(raw));
        await Bun.write(`${base}.json`, JSON.stringify(show(parsed), null, 1));
    }
}
send(7, Cbor.encode(new CborArray([new CborUInt(5)])).toBuffer()); // release
send(7, Cbor.encode(new CborArray([new CborUInt(7)])).toBuffer()); // done
sock.end(); process.exit(0);
