#!/usr/bin/env bun
/**
 * Byte-compare GetFilteredDelegationsAndRewardAccounts (Shelley query 10) for EVERY registered stake
 * credential between a Gerolamo node and a cardano-node, at one block: the reward balances the
 * withdrawal-amount and zero-balance rules read (bugs 272/274). The credential list comes from the
 * node's own LMDB store, opened read-only; both sides acquire our tip.
 *   GEROLAMO_DB_PATH=<scratch>.db bun scripts/reward-accounts-compare.ts --node <node dir> --ours <socket> --ref <socket> [--magic 2] [--batch 2000]
 */
import { join } from "node:path";
import { CborArray, CborBytes, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { openLsq } from "./lib/lsq";
import { attachReadOnlyLedgerStore, getLedgerStore, ledgerStakeReads } from "../src/ledger/nodeLedgerStore";
import { logger, LogLevel } from "../src/utils/logger";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const node = arg("node"), oursSock = arg("ours"), refSock = arg("ref");
if (!node || !oursSock || !refSock) { console.error("usage: --node <dir> --ours <socket> --ref <socket> [--magic 2] [--batch 2000]"); process.exit(2); }
if (!process.env.GEROLAMO_DB_PATH) { console.error("set GEROLAMO_DB_PATH to a scratch file: this tool must not open the node's SQLite"); process.exit(2); }
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);
const magic = Number(arg("magic", "2")), batch = Number(arg("batch", "2000")), era = Number(arg("era", "6"));

attachReadOnlyLedgerStore({ dbPath: join(node, "preview.db"), ledgerDir: join(node, "ledger"), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
const sr = ledgerStakeReads();
if (!sr) { console.error("no LMDB ledger store"); process.exit(1); }
// typed hex (56 = key hash, "01" + 56 = script) → [type, hash]; Credential order: ScriptHashObj before KeyHashObj, then bytes
const creds = [...sr.registeredStakeKeys()].map((k) => ({ t: k.length === 58 ? 1 : 0, h: k.slice(-56) }))
    .sort((a, b) => (a.t !== b.t ? b.t - a.t : a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
getLedgerStore()?.close();
console.log(`${creds.length} registered stake credential(s) in ${node}`);

const U = (n: number) => new CborUInt(n);
const ledger = (q: CborObj[]) => new CborArray([U(0), new CborArray([U(0), new CborArray([U(era), new CborArray(q)])])]);
const ours = await openLsq(oursSock, magic, { acquire: false, timeoutMs: 600_000 });
const ref = await openLsq(refSock, magic, { acquire: false, timeoutMs: 600_000 });
await ours.acquire("tip");
const tip = (await ours.query(new CborArray([U(3)]))) as CborArray;
const point = { slot: BigInt((tip.array[0] as CborUInt).num), hash: Buffer.from((tip.array[1] as CborBytes).bytes).toString("hex") };
const a = await ref.acquire(point);
if (!a.ok) { console.error(`the reference cannot acquire ${point.slot}:${point.hash} (${a.failure}); retry`); process.exit(1); }
console.log(`both at ${point.slot}:${point.hash.slice(0, 16)}…`);
let same = 0, diff = 0;
for (let i = 0; i < creds.length; i += batch) {
    const set = new CborTag(258, new CborArray(creds.slice(i, i + batch).map((c) => new CborArray([U(c.t), new CborBytes(Uint8Array.from(Buffer.from(c.h, "hex")))]))));
    const q = ledger([U(10), set]);
    const [x, y] = await Promise.all([ours.queryRaw(q), ref.queryRaw(q)]);
    if (Buffer.from(x).equals(Buffer.from(y))) same++; else { diff++; console.log(`DIFF batch ${i / batch}: ours ${x.length} B, ref ${y.length} B`); }
}
console.log(`${Math.ceil(creds.length / batch)} batch(es) of ${batch}: ${same} byte-identical, ${diff} different (${creds.length} accounts: delegations and reward balances)`);
ours.close(); ref.close();
process.exit(diff ? 1 : 0);
