#!/usr/bin/env bun
/**
 * KES dual-run soak — pure-TS @harmoniclabs/kes vs wasm-kes on real headers.
 *
 * Usage:
 *   bun scripts/kes-soak-dualrun.mjs [--db PATH] [--limit N] [--offset M]
 *                                    [--from-slot S] [--json-out PATH]
 *
 * Exit 0 iff diverge === 0.
 */
import { Database } from "bun:sqlite";
import {
  MultiEraBlock,
  ConwayHeader,
  BabbageHeader,
  AlonzoHeader,
  MaryHeader,
  AllegraHeader,
  ShelleyHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborArray, CborUInt } from "@harmoniclabs/cbor";
import { verify as tsVerify } from "@harmoniclabs/kes";
import * as wasm from "wasm-kes";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db") ?? "ledger/gerolamo.db";
const limit = Number(arg("limit") ?? 500);
const offset = Number(arg("offset") ?? 0);
const fromSlot = arg("from-slot") != null ? Number(arg("from-slot")) : null;
const jsonOut = arg("json-out");

const network = process.env.NETWORK === "mainnet" ? "mainnet" : "preprod";
const genesisPath =
  network === "mainnet"
    ? "src/config/mainnet/shelley-genesis.json"
    : "src/config/preprod/shelley-genesis.json";
const genesis = JSON.parse(await Bun.file(genesisPath).text());
const slotsPerKES = BigInt(genesis.slotsPerKESPeriod);
const maxEvo = BigInt(genesis.maxKESEvolutions);

function toBytes(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      if (typeof j === "string") return new Uint8Array(Buffer.from(j, "hex"));
      if (Array.isArray(j)) return new Uint8Array(j);
    } catch {
      /* hex */
    }
    return new Uint8Array(Buffer.from(v, "hex"));
  }
  if (Array.isArray(v)) return new Uint8Array(v);
  return null;
}

const HEADER_CLASSES = [
  ConwayHeader,
  BabbageHeader,
  AlonzoHeader,
  MaryHeader,
  AllegraHeader,
  ShelleyHeader,
];

/** Parse era-tagged MultiEraBlock, or wrap raw block with eras 3–7. */
function parseHeaderFromBlockCbor(u8) {
  try {
    return MultiEraBlock.fromCbor(u8).block.header;
  } catch {
    /* need wrap */
  }
  let parsed;
  try {
    parsed = Cbor.parse(u8);
  } catch {
    return null;
  }
  for (const era of [7, 6, 5, 4, 3]) {
    try {
      const wrapped = Cbor.encode(new CborArray([new CborUInt(era), parsed])).toBuffer();
      return MultiEraBlock.fromCbor(wrapped).block.header;
    } catch {
      /* next era */
    }
  }
  return null;
}

function parseHeaderDirect(u8) {
  for (const Cls of HEADER_CLASSES) {
    try {
      return Cls.fromCbor(u8);
    } catch {
      /* next */
    }
  }
  return null;
}

function extractKes(header) {
  if (!header?.body?.opCert) return null;
  const sig = header.kesSignature;
  const pk = header.body.opCert.kesPubKey;
  if (!sig || !pk) return null;
  if (sig.length !== 448) return null;
  let bodyBytes;
  try {
    bodyBytes = header.body.toCborBytes();
  } catch {
    return null;
  }
  const slot = BigInt(header.body.slot);
  const opcertPeriod = BigInt(header.body.opCert.kesPeriod);
  const slotKES = slot / slotsPerKES;
  if (opcertPeriod > slotKES) return { skip: true, reason: "opcert_future" };
  if (slotKES >= opcertPeriod + maxEvo) return { skip: true, reason: "expired" };
  const period = Number(slotKES - opcertPeriod);
  if (period < 0 || !Number.isFinite(period)) return { skip: true, reason: "bad_period" };
  return { sig, pk, bodyBytes, slot, period, era: header.constructor?.name };
}

console.log(
  JSON.stringify({
    phase: "start",
    dbPath,
    limit,
    offset,
    fromSlot,
    network,
    slotsPerKES: Number(slotsPerKES),
    maxEvo: Number(maxEvo),
  }),
);

const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA busy_timeout=5000");

// Prefer fuller CBOR columns when present
let sql = `
  SELECT slot,
         block_data,
         header_data,
         block_fetch_RawCbor
  FROM blocks
  WHERE (block_data IS NOT NULL OR header_data IS NOT NULL OR block_fetch_RawCbor IS NOT NULL)
`;
const params = [];
if (fromSlot != null) {
  sql += ` AND slot >= ?`;
  params.push(fromSlot);
}
sql += ` ORDER BY slot DESC LIMIT ? OFFSET ?`;
params.push(limit, offset);

const rows = db.query(sql).all(...params);

let match = 0;
let diverge = 0;
let skip = 0;
let parseFail = 0;
let tsTrue = 0;
let wasmTrue = 0;
const divergences = [];
const skipReasons = {};

for (const row of rows) {
  let header = null;
  const candidates = [
    row.header_data,
    row.block_data,
    row.block_fetch_RawCbor,
  ];
  for (const raw of candidates) {
    const u8 = toBytes(raw);
    if (!u8?.length) continue;
    header = parseHeaderDirect(u8) ?? parseHeaderFromBlockCbor(u8);
    if (header) break;
  }
  if (!header) {
    parseFail++;
    continue;
  }

  const kes = extractKes(header);
  if (!kes) {
    skip++;
    skipReasons.no_kes = (skipReasons.no_kes ?? 0) + 1;
    continue;
  }
  if (kes.skip) {
    skip++;
    skipReasons[kes.reason] = (skipReasons[kes.reason] ?? 0) + 1;
    continue;
  }

  const { sig, pk, bodyBytes, slot, period } = kes;
  let tsOk;
  let wasmOk;
  try {
    tsOk = tsVerify(sig, period, pk, bodyBytes);
    wasmOk = wasm.verify(sig, period, pk, bodyBytes);
  } catch (e) {
    parseFail++;
    skipReasons.verify_throw = (skipReasons.verify_throw ?? 0) + 1;
    continue;
  }

  if (tsOk) tsTrue++;
  if (wasmOk) wasmTrue++;

  if (tsOk === wasmOk) {
    match++;
  } else {
    diverge++;
    if (divergences.length < 20) {
      divergences.push({
        slot: Number(slot),
        period,
        tsOk,
        wasmOk,
        pk: Buffer.from(pk).toString("hex").slice(0, 16),
        sig: Buffer.from(sig).toString("hex").slice(0, 16),
      });
    }
  }
}

db.close();

const result = {
  match,
  diverge,
  skip,
  parseFail,
  tsTrue,
  wasmTrue,
  rows: rows.length,
  skipReasons,
  sample: divergences,
  exitOk: diverge === 0,
};

console.log(JSON.stringify(result, null, 2));
if (jsonOut) {
  await Bun.write(jsonOut, JSON.stringify(result, null, 2));
  console.log(`wrote ${jsonOut}`);
}

process.exit(diverge === 0 ? 0 : 1);
