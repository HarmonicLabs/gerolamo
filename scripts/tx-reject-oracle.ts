/**
 * Byte-compare Gerolamo's LocalTxSubmission rejections with a cardano-node's.
 *
 * Builds deliberately INVALID Conway transactions (never signed: every one lacks the vkey
 * witness of the key-locked input it spends, so none can ever be accepted or move funds),
 * submits each to the reference node's N2C socket, and runs Gerolamo's mempool rules on the same
 * transaction against the reference node's own ledger state (UTxO and parameters over
 * LocalStateQuery). Prints SAME / DIFF per failure class with the first differing byte.
 *
 *   bun scripts/tx-reject-oracle.ts --ref <node.socket> [--magic 2] [--addr <key address with ADA>] [--script-addr <script address>]
 *       [--envelopes <dir>]   also write each case as a cardano-cli TextEnvelope (for `transaction submit` comparisons)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { openN2c } from "./lib/n2c";
import { lsqLedgerView, resolvedFromTxOut } from "./lib/lsqLedgerView";
import { ValidatingMempool } from "../src/mempool/ValidatingMempool";
import { rejectMessageBytes } from "../src/mempool/applyTxErr";
import { wrapHfcTx } from "../src/mempool/mempoolTx";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const SOCK = arg("ref", "/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket")!;
const magic = Number(arg("magic", "2"));
const KEY_ADDR = arg("addr", "addr_test1qrlas9zas9ck86p2ntjqlljfdrwl893fnvetvs6yh8f9ca2df9nak0w7k6mkfkcxfwrlt9m96apt0z32ssyuhtfrfp7q3uvvr9")!;
const SCRIPT_ADDR = arg("script-addr", "addr_test1wrgqt57hqa04uy928n5lgqdfllwr6fd9a5a0wjxf87e6g6g0d7ecm")!;
const U = (n: number | bigint) => new CborUInt(n);
const B = (h: string) => new CborBytes(Uint8Array.from(Buffer.from(h, "hex")));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const addrBytes = (s: string) => new CborBytes(Address.fromString(s).toBuffer());
const FAKE = "ff".repeat(32);

const c = await openN2c(SOCK, magic);
const view = await lsqLedgerView(c, magic === 764824073 ? "mainnet" : "testnet", magic === 2 ? "preview" : magic === 1 ? "preprod" : "mainnet");

async function utxosAt(address: string): Promise<Array<{ ref: string; lovelace: bigint; adaOnly: boolean; inline: boolean }>> {
    c.send(7, Cbor.encode(new CborArray([U(3), new CborArray([U(0), new CborArray([U(0), new CborArray([U(6), new CborArray([U(6), new CborTag(258, new CborArray([addrBytes(address)]))])])])])])).toBuffer());
    const r = Cbor.parse(await c.recv(7)) as CborArray;
    const m = (r.array[1] as CborArray).array[0] as CborMap;
    return m.map.map(({ k, v }) => {
        const [id, ix] = (k as CborArray).array as [CborBytes, CborUInt];
        const ref = `${hex(id.bytes)}:${Number(ix.num)}`;
        const u = resolvedFromTxOut(ref, v);
        return { ref, lovelace: u.value.get("lovelace") ?? 0n, adaOnly: [...u.value.keys()].every((k) => k === "lovelace"), inline: !!u.inlineDatumCbor };
    });
}

const keyUtxos = (await utxosAt(KEY_ADDR)).filter((u) => u.adaOnly && u.lovelace >= 20_000_000n).sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1));
if (!keyUtxos.length) { console.error(`no ada-only UTxO of 20 ADA or more at ${KEY_ADDR}; pass --addr`); process.exit(2); }
const REAL = { ...keyUtxos[0]!, id: keyUtxos[0]!.ref.split(":")[0]!, ix: Number(keyUtxos[0]!.ref.split(":")[1]) };
const scriptUtxos = (await utxosAt(SCRIPT_ADDR)).filter((u) => u.inline);
const SCR = scriptUtxos[0] ? { id: scriptUtxos[0].ref.split(":")[0]!, ix: Number(scriptUtxos[0].ref.split(":")[1]) } : null;
console.log(`key input ${REAL.ref} (${REAL.lovelace} lovelace)${SCR ? `, script input ${SCR.id}:${SCR.ix}` : ", no script input (collateral cases skipped)"}`);

const inset = (ins: Array<[string, number]>) => new CborTag(258, new CborArray([...ins].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map(([i, x]) => new CborArray([B(i), U(x)]))));
function body(o: { ins: Array<[string, number]>; outs: Array<[string, bigint]>; fee: bigint; ttl?: bigint; start?: bigint; extra?: Array<{ k: CborUInt; v: CborObj }> }): CborMap {
    const m: Array<{ k: CborUInt; v: CborObj }> = [
        { k: U(0), v: inset(o.ins) },
        { k: U(1), v: new CborArray(o.outs.map(([a, l]) => new CborMap([{ k: U(0), v: addrBytes(a) }, { k: U(1), v: U(l) }]))) },
        { k: U(2), v: U(o.fee) },
    ];
    if (o.ttl != null) m.push({ k: U(3), v: U(o.ttl) });
    if (o.start != null) m.push({ k: U(8), v: U(o.start) });
    for (const e of o.extra ?? []) m.push(e);
    m.sort((a, b) => Number(a.k.num - b.k.num));
    return new CborMap(m);
}
const txOf = (b: CborMap, wits: CborObj = new CborMap([]), aux: CborObj = new CborSimple(null)) => Cbor.encode(new CborArray([b, wits, new CborSimple(true), aux])).toBuffer();

async function submitRef(tx: Uint8Array): Promise<Uint8Array> {
    c.send(6, Cbor.encode(new CborArray([U(0), wrapHfcTx(6, tx)])).toBuffer());
    return c.recv(6);
}

const fee = 2_000_000n;
const cases: Array<{ name: string; build: (tip: bigint) => Uint8Array }> = [
    { name: "all inputs spent (MempoolFailure)", build: () => txOf(body({ ins: [[FAKE, 0]], outs: [[KEY_ADDR, 5_000_000n]], fee })) },
    { name: "bad inputs", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [FAKE, 3]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee })) },
    { name: "missing vkey witness", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee })) },
    { name: "fee too small", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - 1000n]], fee: 1000n })) },
    { name: "value not conserved", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace]], fee })) },
    { name: "expired (ttl)", build: (tip) => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, ttl: tip - 100n })) },
    { name: "not yet valid", build: (tip) => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, start: tip + 100_000n })) },
    { name: "output too small", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee - 100_000n], [KEY_ADDR, 100_000n]], fee })) },
    { name: "expired + fee too small", build: (tip) => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - 1000n]], fee: 1000n, ttl: tip - 100n })) },
    { name: "bad input + value + small output", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [FAKE, 3]], outs: [[KEY_ADDR, REAL.lovelace], [KEY_ADDR, 1000n]], fee })) },
    { name: "wrong network (output)", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [["addr1q9d34spgg2kdy47n82e7x9pdd6vql6d2engxmpj20jmhuc2047yqd4xnh7u6u5jp4t0q3fkxzckph4tgnzvamlu7k5psuahzcp", REAL.lovelace - fee]], fee })) },
    { name: "wrong network id in body", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(15), v: U(magic === 764824073 ? 0 : 1) }] })) },
    { name: "required signer missing", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(14), v: new CborTag(258, new CborArray([B("ab".repeat(28))])) }] })) },
    { name: "max tx size", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), new CborMap([]), new CborMap([{ k: U(674), v: new CborBytes(new Uint8Array(20000)) }])) },
    { name: "metadata without hash", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), new CborMap([]), new CborMap([{ k: U(674), v: new CborBytes(new Uint8Array(8)) }])) },
    { name: "metadata hash without metadata", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(7), v: B("11".repeat(32)) }] })) },
];
// more classes
// UTxOs looked up by reference (an address query on a busy address returns megabytes)
const TOKEN_UTXO = arg("token-utxo", "d462c7d0cefceb26c0647a86149da76953ce9b25b79db5631d7bd5ed7e031ba8:5")!;
const REFSCRIPT_UTXO = arg("refscript-utxo", "5df1e135e012d666984ad32ff24f79226ee9c84fa77640b6b2b700351dab619c:0")!;
const byRef = await view.resolve([TOKEN_UTXO, REFSCRIPT_UTXO]);
const tokenUtxo = byRef.get(TOKEN_UTXO) && [...byRef.get(TOKEN_UTXO)!.value.keys()].some((k) => k !== "lovelace") ? { ref: TOKEN_UTXO } : null;
const refScriptUtxo = byRef.get(REFSCRIPT_UTXO)?.referenceScriptCbor ? { ref: REFSCRIPT_UTXO } : null;
if (!tokenUtxo) console.log(`token UTxO ${TOKEN_UTXO} is spent or has no tokens: case skipped (pass --token-utxo)`);
if (!refScriptUtxo) console.log(`reference-script UTxO ${REFSCRIPT_UTXO} is spent or has no script: case skipped (pass --refscript-utxo)`);
const stakeKey = Buffer.from(Address.fromString(KEY_ADDR).toBuffer()).subarray(29, 57).toString("hex");
const nativeSig = Cbor.encode(new CborArray([U(0), B("cd".repeat(28))])).toBuffer(); // sig <key nobody holds>
const nativePolicy = (() => { const pre = new Uint8Array(1 + nativeSig.length); pre[0] = 0; pre.set(nativeSig, 1); return hex(blake2b_224(pre)); })();
const randomVkeyWitness = new CborMap([{ k: U(0), v: new CborTag(258, new CborArray([new CborArray([B("5a".repeat(32)), B("a5".repeat(64))])])) }]);
cases.push(
    { name: "invalid vkey signature", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), randomVkeyWitness) },
    { name: "withdrawal on another network", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(5), v: new CborMap([{ k: B("e1" + "77".repeat(28)), v: U(0) }]) }] })) },
    { name: "stake key already registered", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee - 2_000_000n]], fee, extra: [{ k: U(4), v: new CborTag(258, new CborArray([new CborArray([U(7), new CborArray([U(0), B(stakeKey)]), U(2_000_000)])])) }] })) },
    { name: "delegation of an unregistered stake key", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(4), v: new CborTag(258, new CborArray([new CborArray([U(2), new CborArray([U(0), B("ef".repeat(28))]), B("8df215df1a762e84d826bae39516a424a76e81e649001a3f903eda12")])])) }] })) },
    { name: "native script not satisfied (mint)", build: () => txOf(new CborMap([...body({ ins: [[REAL.id, REAL.ix]], outs: [], fee }).map.filter((e) => Number((e.k as CborUInt).num) !== 1), { k: U(1), v: new CborArray([new CborMap([{ k: U(0), v: addrBytes(KEY_ADDR) }, { k: U(1), v: new CborArray([U(REAL.lovelace - fee), new CborMap([{ k: B(nativePolicy), v: new CborMap([{ k: B(""), v: U(1) }]) }])]) }])]) }, { k: U(9), v: new CborMap([{ k: B(nativePolicy), v: new CborMap([{ k: B(""), v: U(1) }]) }]) }].sort((a, b) => Number((a.k as CborUInt).num - (b.k as CborUInt).num))), new CborMap([{ k: U(1), v: new CborTag(258, new CborArray([Cbor.parse(nativeSig)])) }])) },
    { name: "extraneous script witness", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), new CborMap([{ k: U(1), v: new CborTag(258, new CborArray([Cbor.parse(nativeSig)])) }])) },
    { name: "supplemental datum not allowed + integrity hash", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), new CborMap([{ k: U(4), v: new CborTag(258, new CborArray([U(42)])) }])) },
    { name: "too many collateral inputs", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(13), v: inset([[REAL.id, REAL.ix], [FAKE, 1], [FAKE, 2], [FAKE, 4]]) }] }), new CborMap([{ k: U(5), v: new CborMap([{ k: new CborArray([U(1), U(0)]), v: new CborArray([U(0), new CborArray([U(1000), U(1000)])]) }]) }])) },
);
if (tokenUtxo) { const [tid, tix] = tokenUtxo.ref.split(":"); cases.push({ name: "collateral carries tokens", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(13), v: inset([[tid!, Number(tix)]]) }] }), new CborMap([{ k: U(5), v: new CborMap([{ k: new CborArray([U(1), U(0)]), v: new CborArray([U(0), new CborArray([U(1000), U(1000)])]) }]) }])) }); }
if (refScriptUtxo) { const [rid, rix] = refScriptUtxo.ref.split(":"); cases.push({ name: "reference-script fee (fee too small)", build: () => txOf(body({ ins: [[REAL.id, REAL.ix]], outs: [[KEY_ADDR, REAL.lovelace - 1000n]], fee: 1000n, extra: [{ k: U(18), v: inset([[rid!, Number(rix)]]) }] })) }); }
if (SCR) {
    const rdmrs = (mem: bigint) => new CborMap([{ k: U(5), v: new CborMap([{ k: new CborArray([U(0), U(0)]), v: new CborArray([U(0), new CborArray([U(mem), U(1000)])]) }]) }]);
    cases.push(
        { name: "script: no collateral, missing script, extra redeemer", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [SCR.id, SCR.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), rdmrs(1000n)) },
        { name: "script: total collateral mismatch", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [SCR.id, SCR.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(13), v: inset([[REAL.id, REAL.ix]]) }, { k: U(17), v: U(5_000_000) }] }), rdmrs(1000n)) },
        { name: "script: insufficient collateral", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [SCR.id, SCR.ix]], outs: [[KEY_ADDR, 1_000_000n]], fee: REAL.lovelace - 1_000_000n, extra: [{ k: U(13), v: inset([[REAL.id, REAL.ix]]) }] }), rdmrs(1000n)) },
        { name: "script: collateral locked by a script", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [SCR.id, SCR.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee, extra: [{ k: U(13), v: inset([[SCR.id, SCR.ix]]) }] }), rdmrs(1000n)) },
        { name: "script: ex units too big", build: () => txOf(body({ ins: [[REAL.id, REAL.ix], [SCR.id, SCR.ix]], outs: [[KEY_ADDR, REAL.lovelace - fee]], fee }), rdmrs(999_000_000_000n)) },
    );
}

let same = 0, total = 0;
const envDir = arg("envelopes");
if (envDir) mkdirSync(envDir, { recursive: true });
for (const [n, k] of cases.entries()) {
    let ours = "", ref = "", reasons: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        await view.reacquire();
        const tip = (await view.tip())!.slot;
        const tx = k.build(tip);
        if (envDir) writeFileSync(`${envDir}/${String(n).padStart(2, "0")}.tx.json`, JSON.stringify({ type: "Tx ConwayEra", description: k.name, cborHex: hex(tx) }, null, 2));
        ref = hex(await submitRef(tx));
        const mp = new ValidatingMempool({ view });
        const r = await mp.addTx(tx, "oracle");
        ours = r.ok ? "8101" : hex(rejectMessageBytes(r.failures));
        reasons = r.ok ? ["accepted"] : r.reasons;
        const tipAfter = (await view.tip())!.slot;
        if (ours === ref || tipAfter === tip) break; // a block between the two validations can change the verdict: retry
    }
    total++;
    const ok = ours === ref;
    if (ok) same++;
    let where = "";
    if (!ok) { let i = 0; while (i < ours.length && ours[i] === ref[i]) i++; where = `\n    first difference at byte ${i >> 1}\n    ours ${ours}\n    ref  ${ref}\n    (${reasons.join("; ")})`; }
    console.log(`${ok ? "SAME" : "DIFF"}  ${k.name}${where}`);
}
console.log(`${same} of ${total} byte-identical`);
c.close();
process.exit(same === total ? 0 : 1);
