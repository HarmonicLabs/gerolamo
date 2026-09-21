// Dry-build the producer's greeting transaction ("Gerolamo was here!") from the node DB and decode it; nothing is submitted, no key material is printed.
// Usage: GEROLAMO_DB_PATH=<preview.db> NETWORK=preview bun scripts/greeting-dry-run.ts <node config.json>
import { sql } from "../src/sql";
import { getChainTip } from "../src/db";
import { attachReadOnlyBlockStore } from "../src/storage/nodeBlockStore";
import { readEpochParamsRaw } from "../src/consensus/epochParams";
import { epochForSlot } from "../src/utils/epochFromSlotCalculations";
import * as op from "../src/pool/operator";
import { Tx } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor } from "@harmoniclabs/cbor";
const g = JSON.parse(await Bun.file(process.argv[2] ?? "/media/bakon/data/cardano/gerolamo-preview-mithril/config.json").text()).producer.greeting;
const key = op.loadSigningKey(g.paymentSkeyFile, (op as any).KeyEnvelopeType?.paymentSigning ?? "PaymentSigningKeyShelley_ed25519");
const address = op.bech32Decode(g.paymentAddress).bytes;
const rows = (await sql`SELECT utxo_ref, lovelace, tx_out FROM utxo WHERE address = ${g.paymentAddress}`.values()) as unknown[][];
const usable = rows.map((r) => ({ ref: String(r[0]), lovelace: BigInt(String(r[1] ?? 0)), txOut: String(r[2] ?? "{}") }))
  .filter((u) => { try { const a = JSON.parse(u.txOut)?.assets ?? {}; return Object.keys(a).every((k) => k === "") && u.lovelace >= 2_000_000n; } catch { return false; } })
  .sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1));
console.log("usable UTxOs:", usable.length, usable[0] ? usable[0].ref + " " + usable[0].lovelace + " lovelace" : "");
await attachReadOnlyBlockStore({ dbPath: process.env.GEROLAMO_DB_PATH ?? "", blockStoreDir: (g as any).blockStoreDir }, Number((g as any).securityParam ?? 432)); // the chain lives in the block store, not in SQLite
const tip = await getChainTip(); if (!tip) throw new Error("no tip");
const raw = (await readEpochParamsRaw(Number(epochForSlot(tip.slot, "preview")))) ?? {};
const [txHash, index] = usable[0]!.ref.split(":");
const built = (op as any).buildWithMinFee({
  inputs: [{ txHash: Uint8Array.from(Buffer.from(txHash!, "hex")), index: Number(index) }],
  outputs: [{ address, lovelace: usable[0]!.lovelace }], changeIndex: 0,
  ttl: tip.slot + 7200n, certificates: [],
  auxiliaryData: op.messageMetadata(["Gerolamo was here!"]),
  minFeeA: BigInt(String((raw as any).min_fee_a ?? 44)), minFeeB: BigInt(String((raw as any).min_fee_b ?? 155381)), keys: [key],
});
const bytes: Uint8Array = built.tx;
console.log("tx bytes:", bytes.length, "hash:", Buffer.from(op.txId(built.body)).toString("hex"));
const tx = Tx.fromCbor(bytes);
const body: any = tx.body;
console.log("fee:", String(body.fee), "ttl:", String(body.ttl), "inputs:", body.inputs.length, "outputs:", body.outputs.length, "out lovelace:", String(body.outputs[0].value.lovelaces), "in − fee:", String(usable[0]!.lovelace - BigInt(body.fee)));
console.log("aux data hash in body:", body.auxDataHash ? Buffer.from(body.auxDataHash.toBuffer ? body.auxDataHash.toBuffer() : body.auxDataHash).toString("hex").slice(0, 16) + "…" : "MISSING");
console.log("vkey witnesses:", tx.witnesses.vkeyWitnesses?.length ?? 0, "isScriptValid:", tx.isScriptValid);
const aux: any = tx.auxiliaryData;
const md = aux?.metadata ?? aux?.metadatum ?? aux;
const cbor = Cbor.parse(bytes) as any;
const auxRaw = cbor.array?.[3];
const { blake2b_256 } = await import("@harmoniclabs/crypto");
const auxBytes = auxRaw ? Cbor.encode(auxRaw).toBuffer() : null;
const auxHash = auxBytes ? Buffer.from(blake2b_256(auxBytes)).toString("hex") : null;
const bodyHashHex = body.auxDataHash ? Buffer.from(body.auxDataHash.toBuffer ? body.auxDataHash.toBuffer() : body.auxDataHash).toString("hex") : null;
console.log("aux data hash matches body:", auxHash && bodyHashHex ? (auxHash === bodyHashHex ? "YES" : "NO " + auxHash.slice(0, 16)) : "n/a");
const show = (o: any): any => o?.map ? Object.fromEntries(o.map.map((e: any) => [show(e.k), show(e.v)])) : o?.array ? o.array.map(show) : o?.num != null ? String(o.num) : o?.text != null ? o.text : o?.bytes ? Buffer.from(o.bytes).toString("hex") : o;
console.log("metadata:", JSON.stringify(show(auxRaw?.map ? auxRaw : (auxRaw?.array?.[0] ?? auxRaw))));
process.exit(0);
