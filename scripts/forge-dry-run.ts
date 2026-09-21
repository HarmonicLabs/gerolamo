// Forge an EMPTY block at the current DB tip with the pool keys and run it through the same
// header parse adoptLocalBlock uses; nothing is published or stored, no key material is printed.
// Usage: GEROLAMO_DB_PATH=<db> NETWORK=preview bun scripts/forge-dry-run.ts <node config.json>
import { getChainTipFromHeader } from "../src/db";
import { attachReadOnlyBlockStore } from "../src/storage/nodeBlockStore";
import { attachReadOnlyLedgerStore } from "../src/ledger/nodeLedgerStore";
import { readEpochParamsRaw } from "../src/consensus/epochParams";
import { getEpochNonce } from "../src/db";
import { epochForSlot } from "../src/utils/epochFromSlotCalculations";
import { EMPTY_BODY, forgeBlock } from "../src/pool/forge";
import { loadColdVerificationKey, loadKesSigningKey, loadVrfSigningKey, readOperationalCert } from "../src/pool/keystore";
import { blockFetchHeaderIdentity as headerIdentityOfBlock } from "../src/consensus/blockHeaderParser";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
const cfgPath = process.argv[2] ?? "/media/bakon/data/cardano/gerolamo-preview-mithril/config.json";
const cfg = JSON.parse(await Bun.file(cfgPath).text());
const pc = cfg.producer;
const genesis = await Bun.file(cfg.shelleyGenesisFile ?? "./src/config/preview/shelley-genesis.json").json();
await attachReadOnlyBlockStore({ dbPath: process.env.GEROLAMO_DB_PATH ?? "", blockStoreDir: cfg.blockStoreDir }, Number(genesis.securityParam ?? 432));
attachReadOnlyLedgerStore({ dbPath: process.env.GEROLAMO_DB_PATH ?? "", ledgerDir: cfg.ledgerDir, ledgerStore: cfg.ledgerStore, blockStoreDir: cfg.blockStoreDir }); // GEROLAMO_LEDGER_STORE=lmdb routes the ledger reads through LMDB // the chain lives in the block store, not in SQLite
const tip = await getChainTipFromHeader(); if (!tip) throw new Error("no tip");
console.log("tip slot", String(tip.slot), "header block number", String(tip.blockNumber), "db block_no", String(tip.dbBlockNumber), tip.blockNumber !== tip.dbBlockNumber ? "(DRIFT: forging from the header)" : "(match)");
const era = Number(process.argv[3] ?? 7);
const slot = tip.slot + 5n;
const epoch = Number(epochForSlot(slot, "preview"));
const nonceHex = await getEpochNonce(epoch); if (!nonceHex) throw new Error("no nonce");
const raw: any = (await readEpochParamsRaw(epoch)) ?? {};
const forged = forgeBlock({
  era, blockNumber: tip.blockNumber + 1n, slot, prevHash: Uint8Array.from(Buffer.from(tip.hashHex, "hex")), nonce: Uint8Array.from(Buffer.from(String(nonceHex), "hex")),
  coldVkey: loadColdVerificationKey(pc.coldVkeyFile), vrf: loadVrfSigningKey(pc.vrfSkeyFile), kes: loadKesSigningKey(pc.kesSkeyFile), opcert: readOperationalCert(pc.opcertFile).cert,
  protocolVersion: pc.headerProtocolVersion ?? { major: Number(raw.protocol_major_ver ?? raw.protocol_major ?? 10), minor: Number(raw.protocol_minor_ver ?? raw.protocol_minor ?? 0) },
  slotsPerKESPeriod: BigInt(genesis.slotsPerKESPeriod), body: EMPTY_BODY,
});
console.log("forged", forged.blockFetchBytes.length, "bytes; era", era, "slot", slot, "kes evolution", forged.kesEvolution, "hash", Buffer.from(forged.headerHash).toString("hex").slice(0, 16));
const top = Cbor.parse(forged.blockFetchBytes) as any;
console.log("block-fetch wrapper: array of", top.array?.length, "first =", String(top.array?.[0]?.num));
const identity = headerIdentityOfBlock(forged.blockFetchBytes);
console.log("identity era", identity.era, "raw header bytes", identity.rawHeaderBytes.length);
// exactly what adoptLocalBlock does now: full MsgRollForward → headerParser → validateHeader
const { headerParser, localRollForwardMessage } = await import("../src/consensus/blockHeaderParser");
const { validateHeader } = await import("../src/consensus/BlockHeaderValidator");
const local = localRollForwardMessage(forged.blockFetchBytes);
console.log("roll-forward message", local.bytes.length, "bytes; slot", String(local.slot), "blockNo", String(local.blockNo), "hash", local.hashHex.slice(0, 16));
try {
  const parsed = await headerParser(local.bytes);
  console.log("PARSED OK: slot", String(parsed?.slot), "era", parsed?.era, "epoch", parsed?.epoch, "prev", parsed?.prevHashHex?.slice(0, 16), "prev matches tip:", parsed?.prevHashHex === tip.hashHex.toLowerCase());
  const ok = await validateHeader(parsed!.multiEraHeader, Uint8Array.from(Buffer.from(String(nonceHex), "hex")), { networkMagic: 2, shelleyGenesisFile: cfg.shelleyGenesisFile ?? "src/config/preview/shelley-genesis.json", network: "preview" });
  console.log("validateHeader (VRF / leader / KES / opcert):", ok ? "PASS" : "FAIL");
} catch (e: any) { console.log("PARSE ERROR:", e?.message ?? e); }
const hdr = Cbor.parse(identity.rawHeaderBytes) as any;
console.log("header protocol version:", String(hdr.array?.[0]?.array?.[9]?.array?.[0]?.num) + "." + String(hdr.array?.[0]?.array?.[9]?.array?.[1]?.num));
console.log("header: array", hdr.array?.length, "body array", hdr.array?.[0]?.array?.length, "body[0..]", (hdr.array?.[0]?.array ?? []).slice(0, 12).map((x: any) => x.num != null ? "uint" : x.bytes ? "bytes" + x.bytes.length : x.array ? "array" + x.array.length : x.constructor?.name).join(" "));
process.exit(0);
