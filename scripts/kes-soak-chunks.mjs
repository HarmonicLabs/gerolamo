#!/usr/bin/env bun
/**
 * KES dual-run soak from cardano-node ImmutableDB chunks.
 * pure-TS @harmoniclabs/kes vs wasm-kes on real headers.
 *
 * Usage:
 *   bun scripts/kes-soak-chunks.mjs [--chunks DIR] [--from-chunk N] [--to-chunk N]
 *                                   [--max-blocks N] [--json-out PATH]
 *
 * Exit 0 iff diverge === 0.
 *
 * Chunk layout matches src/state/legacy.ts parseChunk (primary/secondary/chunk).
 */
import { readdirSync } from "node:fs";
import { format, resolve } from "node:path";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { verify as tsVerify } from "@harmoniclabs/kes";
import * as wasm from "wasm-kes";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const chunksDir = resolve(
  arg("chunks") ?? "snapshots/preprod/db/immutable",
);
const fromChunk = Number(arg("from-chunk") ?? 50); // skip early Byron-heavy
const toChunkArg = arg("to-chunk");
const maxBlocks = Number(arg("max-blocks") ?? 2000);
const jsonOut = arg("json-out");

const network = process.env.NETWORK === "mainnet" ? "mainnet" : "preprod";
const genesisPath =
  network === "mainnet"
    ? "src/config/mainnet/shelley-genesis.json"
    : "src/config/preprod/shelley-genesis.json";
const genesis = JSON.parse(await Bun.file(genesisPath).text());
const slotsPerKES = BigInt(genesis.slotsPerKESPeriod);
const maxEvo = BigInt(genesis.maxKESEvolutions);

/** Same layout as src/state/legacy.ts parseChunk */
function parseChunk(primaryDV, secondaryDV, chunkDV) {
  if (primaryDV.getUint8(0) !== 1) {
    throw new Error("Invalid primary version");
  }
  const offsets = Array.from(
    { length: (primaryDV.byteLength - 1) / 4 },
    (_, i) => primaryDV.getUint32(i * 4 + 1, false),
  );
  const filledRelSlots = offsets.flatMap((offset, i) =>
    i < offsets.length - 1 && offset !== offsets[i + 1] ? [i] : [],
  );
  const blockOffs = filledRelSlots.map((relSlot) =>
    secondaryDV.getBigUint64(offsets[relSlot], false),
  );
  return filledRelSlots.map((relSlot, i) => {
    const secOff = offsets[relSlot];
    const blockStartOff = Number(blockOffs[i]);
    const blockEndOff =
      i < filledRelSlots.length - 1
        ? Number(blockOffs[i + 1])
        : chunkDV.byteLength;
    return {
      slotNo: secondaryDV.getBigUint64(secOff + 48, false),
      blockCbor: new Uint8Array(
        chunkDV.buffer.slice(blockStartOff, blockEndOff),
      ),
    };
  });
}

function listChunkNos(dir) {
  const nos = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{5})\.chunk$/.exec(f);
    if (m) nos.push(parseInt(m[1], 10));
  }
  nos.sort((a, b) => a - b);
  return nos;
}

function extractKes(header) {
  if (!header?.body?.opCert) return null;
  const sig = header.kesSignature;
  const pk = header.body.opCert.kesPubKey;
  if (!sig || !pk || sig.length !== 448) return null;
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
  if (period < 0 || !Number.isFinite(period)) {
    return { skip: true, reason: "bad_period" };
  }
  return { sig, pk, bodyBytes, slot, period };
}

const allChunks = listChunkNos(chunksDir);
const maxOnDisk = allChunks[allChunks.length - 1] ?? -1;
const toChunk = toChunkArg != null ? Number(toChunkArg) : maxOnDisk;

console.log(
  JSON.stringify({
    phase: "start",
    chunksDir,
    fromChunk,
    toChunk,
    maxBlocks,
    network,
    slotsPerKES: Number(slotsPerKES),
    maxEvo: Number(maxEvo),
    chunksOnDisk: allChunks.length,
  }),
);

let match = 0;
let diverge = 0;
let skip = 0;
let parseFail = 0;
let byron = 0;
let tsTrue = 0;
let wasmTrue = 0;
let processed = 0;
const divergences = [];
const skipReasons = {};
const eras = {};

const range = allChunks.filter((n) => n >= fromChunk && n <= toChunk);

outer: for (const chunkNo of range) {
  const s = String(chunkNo).padStart(5, "0");
  let blocks;
  try {
    const [p, sec, c] = await Promise.all([
      Bun.file(format({ dir: chunksDir, base: `${s}.primary` })).arrayBuffer(),
      Bun.file(format({ dir: chunksDir, base: `${s}.secondary` })).arrayBuffer(),
      Bun.file(format({ dir: chunksDir, base: `${s}.chunk` })).arrayBuffer(),
    ]);
    blocks = parseChunk(new DataView(p), new DataView(sec), new DataView(c));
  } catch (e) {
    skipReasons.chunk_read = (skipReasons.chunk_read ?? 0) + 1;
    continue;
  }

  for (const b of blocks) {
    if (processed >= maxBlocks) break outer;
    let meb;
    try {
      meb = MultiEraBlock.fromCbor(b.blockCbor);
    } catch {
      byron++;
      parseFail++;
      continue;
    }

    // Byron / no KES
    if (meb.era < 2) {
      byron++;
      skip++;
      skipReasons.byron = (skipReasons.byron ?? 0) + 1;
      continue;
    }

    const header = meb.block.header;
    eras[meb.era] = (eras[meb.era] ?? 0) + 1;

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

    processed++;
    const { sig, pk, bodyBytes, slot, period } = kes;
    let tsOk;
    let wasmOk;
    try {
      tsOk = tsVerify(sig, period, pk, bodyBytes);
      wasmOk = wasm.verify(sig, period, pk, bodyBytes);
    } catch {
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
          chunk: chunkNo,
          slot: Number(slot),
          period,
          era: meb.era,
          tsOk,
          wasmOk,
          pk: Buffer.from(pk).toString("hex").slice(0, 16),
          sig: Buffer.from(sig).toString("hex").slice(0, 16),
        });
      }
    }
  }

  if (chunkNo % 50 === 0) {
    console.log(
      JSON.stringify({
        phase: "progress",
        chunk: chunkNo,
        processed,
        match,
        diverge,
        skip,
        byron,
      }),
    );
  }
}

const result = {
  match,
  diverge,
  skip,
  parseFail,
  byron,
  tsTrue,
  wasmTrue,
  processed,
  eras,
  skipReasons,
  sample: divergences,
  exitOk: diverge === 0 && match > 0,
};

console.log(JSON.stringify(result, null, 2));
if (jsonOut) {
  await Bun.write(jsonOut, JSON.stringify(result, null, 2));
  console.log(`wrote ${jsonOut}`);
}

process.exit(diverge === 0 && match > 0 ? 0 : 1);
