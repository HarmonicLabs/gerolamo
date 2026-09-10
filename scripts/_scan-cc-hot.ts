import { Database } from "bun:sqlite";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
const db = new Database("/media/bakon/data/cardano/gerolamo-preview-mithril/preview.db", { readonly: true });
const [lo, hi] = [Number(process.argv[2]), Number(process.argv[3])];
const colds = new Set((db.query("select cold_credential c from gov_committee").all() as any[]).map((r) => r.c));
const found: any[] = [];
let n = 0;
for (const r of db.query("select slot, block_data from blocks where slot between ? and ? order by slot").iterate(lo, hi) as any) {
  n++;
  let meb: any; try { meb = MultiEraBlock.fromCbor(new Uint8Array(r.block_data)); } catch { continue; }
  for (const body of meb.block?.transactionBodies ?? []) for (const c of body.certs ?? []) {
    const t = Number(c.certType ?? c.type ?? -1); const name = String(c.constructor?.name ?? "");
    if (t === 14 || t === 15 || /AuthCommitteeHot|ResignCommitteeCold/.test(name)) {
      const cold = String(c.coldCredential?.hash ?? c.committeeColdCred?.hash ?? c.cold?.hash ?? "").toLowerCase(); const hot = String(c.hotCredential?.hash ?? c.committeeHotCred?.hash ?? c.hot?.hash ?? "").toLowerCase();
      found.push({ slot: r.slot, epoch: Math.floor(r.slot / 86400), kind: name || t, cold: cold.slice(0, 12), hot: hot.slice(0, 12), member: colds.has(cold), coldFull: cold, hotFull: hot });
    }
  }
}
console.log(`scanned ${n} blocks in ${lo}..${hi}: ${found.length} committee cert(s)`);
for (const f of found) console.log(JSON.stringify(f));
