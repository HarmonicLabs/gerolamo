#!/usr/bin/env bun
/**
 * Off-hot-path MiniBF (mb_*) index backfill.
 *
 * Populates mb_tx / mb_tx_in / mb_tx_out / mb_address_tx / mb_block_tx
 * (+ dual-writes legacy tx_index / address_tx / block_tx for compat).
 *
 * NEVER run against soak batch.db while hydrate is writing — default is .live/test.db.
 *
 * Usage:
 *   bun scripts/backfill-minibf.mjs
 *   bun scripts/backfill-minibf.mjs --db .live/test.db
 *   bun scripts/backfill-minibf.mjs --db .live/test.db --from-slot 1000 --limit 200
 *   bun scripts/backfill-minibf.mjs --db .live/test.db --wipe-mb
 *   bun scripts/backfill-minibf.mjs --dry-run --limit 10
 *
 * Parse path (same as live BlockFetch / backfill-tx-index):
 *   BlockFetchBlock.fromCbor(raw) → MultiEraBlock.fromCbor(blockData) → transactionBodies
 *
 * Does NOT write ledger tables (blocks / utxo / utxo_deltas).
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

const MINIBF_SCHEMA_VERSION = 1;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const WORKDIR = resolve(import.meta.dir, "..");
const DB_PATH = resolve(arg("db", resolve(WORKDIR, ".live/test.db")));
const toSlot = arg("to-slot", null) != null ? Number(arg("to-slot")) : null;
const limit = arg("limit", null) != null ? Number(arg("limit")) : null;
const progressEvery = Number(arg("progress", "50"));
const wipeMb = hasFlag("wipe-mb");
const dryRun = hasFlag("dry-run");
const dualLegacy = !hasFlag("no-legacy");

// Safety: refuse soak path unless explicitly forced
const isBatch =
  DB_PATH.includes(".hydrate/batch.db") || DB_PATH.endsWith("batch.db");
if (isBatch && !hasFlag("force-batch")) {
  console.error(
    "REFUSE: looks like soak batch.db. Pass --force-batch only if hydrate is STOPPED.",
  );
  process.exit(2);
}

if (!existsSync(DB_PATH)) {
  console.error("DB not found:", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH, dryRun ? { readonly: true } : undefined);
db.exec("PRAGMA busy_timeout=10000");
if (!dryRun) {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
}

function ensureMbSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mb_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tip_slot INTEGER NOT NULL DEFAULT 0,
      tip_hash BLOB,
      schema_version INTEGER NOT NULL DEFAULT ${MINIBF_SCHEMA_VERSION},
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS mb_tx (
      tx_hash TEXT PRIMARY KEY,
      block_hash BLOB NOT NULL,
      slot INTEGER NOT NULL,
      block_height INTEGER,
      tx_index INTEGER NOT NULL DEFAULT 0,
      fee TEXT,
      size INTEGER,
      invalid_before TEXT,
      invalid_hereafter TEXT,
      valid_contract INTEGER,
      metadata_label_count INTEGER DEFAULT 0,
      body_cbor BLOB,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mb_tx_slot ON mb_tx(slot);
    CREATE INDEX IF NOT EXISTS idx_mb_tx_block ON mb_tx(block_hash);
    CREATE TABLE IF NOT EXISTS mb_tx_out (
      tx_hash TEXT NOT NULL,
      output_index INTEGER NOT NULL,
      address TEXT NOT NULL,
      payment_cred TEXT,
      stake_cred TEXT,
      lovelace TEXT NOT NULL,
      assets_json TEXT,
      datum_hash TEXT,
      inline_datum_cbor BLOB,
      script_ref_hash TEXT,
      spent_by_tx TEXT,
      spent_at_slot INTEGER,
      PRIMARY KEY (tx_hash, output_index)
    );
    CREATE INDEX IF NOT EXISTS idx_mb_tx_out_addr ON mb_tx_out(address);
    CREATE INDEX IF NOT EXISTS idx_mb_tx_out_unspent
      ON mb_tx_out(address) WHERE spent_by_tx IS NULL;
    CREATE TABLE IF NOT EXISTS mb_tx_in (
      tx_hash TEXT NOT NULL,
      input_index INTEGER NOT NULL,
      prev_tx_hash TEXT NOT NULL,
      prev_output_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, input_index)
    );
    CREATE INDEX IF NOT EXISTS idx_mb_tx_in_prev
      ON mb_tx_in(prev_tx_hash, prev_output_index);
    CREATE TABLE IF NOT EXISTS mb_address_tx (
      address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      slot INTEGER NOT NULL,
      tx_index INTEGER DEFAULT 0,
      direction TEXT CHECK(direction IN ('in','out','both')),
      PRIMARY KEY (address, tx_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_mb_address_tx_slot
      ON mb_address_tx(address, slot DESC);
    CREATE TABLE IF NOT EXISTS mb_block_tx (
      block_hash BLOB NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_index INTEGER NOT NULL,
      PRIMARY KEY (block_hash, tx_hash)
    );
    INSERT OR IGNORE INTO mb_cursor (id, tip_slot, schema_version, updated_at)
    VALUES (1, 0, ${MINIBF_SCHEMA_VERSION}, strftime('%s','now'));
  `);

  // Legacy thin indexes (compat dual-write)
  if (dualLegacy) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tx_index (
        tx_hash TEXT PRIMARY KEY,
        block_hash BLOB,
        slot INTEGER NOT NULL,
        fee TEXT,
        size INTEGER,
        invalid_hereafter TEXT,
        invalid_before TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tx_index_slot ON tx_index(slot);
      CREATE TABLE IF NOT EXISTS address_tx (
        address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        slot INTEGER NOT NULL,
        direction TEXT CHECK(direction IN ('in','out','both')),
        PRIMARY KEY (address, tx_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_address_tx_addr_slot ON address_tx(address, slot DESC);
      CREATE TABLE IF NOT EXISTS block_tx (
        block_hash BLOB NOT NULL,
        tx_hash TEXT NOT NULL,
        tx_index INTEGER NOT NULL,
        PRIMARY KEY (block_hash, tx_hash)
      );
    `);
  }
}

if (!dryRun) {
  ensureMbSchema();
  if (wipeMb) {
    db.exec(`
      DELETE FROM mb_tx_in;
      DELETE FROM mb_tx_out;
      DELETE FROM mb_address_tx;
      DELETE FROM mb_block_tx;
      DELETE FROM mb_tx;
      UPDATE mb_cursor SET tip_slot = 0, tip_hash = NULL,
        updated_at = strftime('%s','now') WHERE id = 1;
    `);
    console.log("wiped mb_* tables");
  }
}

// Resume: default from-slot = mb_cursor.tip_slot (or 0)
let fromSlot =
  arg("from-slot", null) != null ? Number(arg("from-slot")) : null;
if (fromSlot == null || !Number.isFinite(fromSlot)) {
  try {
    const cur = db.prepare("SELECT tip_slot FROM mb_cursor WHERE id = 1").get();
    const tip = cur ? Number(cur.tip_slot) : 0;
    // resume after last indexed slot (exclusive of already-done tip)
    fromSlot = Number.isFinite(tip) && tip > 0 ? tip + 1 : 0;
  } catch {
    fromSlot = 0;
  }
}

console.log("backfill-minibf", {
  db: DB_PATH,
  fromSlot,
  toSlot,
  limit,
  wipeMb,
  dryRun,
  dualLegacy,
});

function asU8(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === "string") {
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
      const out = new Uint8Array(v.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    return new TextEncoder().encode(v);
  }
  try {
    return new Uint8Array(v);
  } catch {
    return null;
  }
}

function hashToHex(h) {
  if (h == null) return "";
  if (typeof h === "string") return h.toLowerCase();
  try {
    if (typeof h.toString === "function") {
      const s = String(h.toString());
      if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    }
  } catch {
    /* */
  }
  try {
    if (typeof h.toBuffer === "function") return toHex(h.toBuffer());
  } catch {
    /* */
  }
  if (h instanceof Uint8Array) return toHex(h);
  return "";
}

function addrToString(a) {
  if (a == null) return "";
  try {
    if (typeof a.toString === "function") return String(a.toString());
  } catch {
    /* */
  }
  return String(a);
}

function parseBlockBody(rawCbor) {
  const raw = asU8(rawCbor);
  if (!raw || raw.length < 8) return null;
  try {
    const bf = BlockFetchBlock.fromCbor(raw);
    if (bf?.blockData) {
      return MultiEraBlock.fromCbor(bf.blockData);
    }
  } catch {
    /* try direct */
  }
  try {
    return MultiEraBlock.fromCbor(raw);
  } catch {
    return null;
  }
}

function extractTxs(meb) {
  const b = meb?.block;
  if (!b) return [];
  const any = b;
  if (Array.isArray(any.transactionBodies)) return any.transactionBodies;
  const payload = any?.body?.txPayload;
  if (Array.isArray(payload)) {
    return payload.map(
      (entry) => entry?.transaction ?? entry?.tx ?? entry?.body ?? entry,
    );
  }
  return [];
}

function assetsJsonFromOutput(output) {
  try {
    const assetsObj = {};
    const multiAssets = Array.isArray(output?.value?.map)
      ? output.value.map
      : [];
    for (const ma of multiAssets) {
      const policyStr = ma?.policy != null ? String(ma.policy.toString()) : "";
      if (!policyStr) continue;
      const assetObj = {};
      for (const asset of Array.isArray(ma.assets) ? ma.assets : []) {
        try {
          const name =
            asset?.name instanceof Uint8Array
              ? toHex(asset.name)
              : typeof asset?.name?.toString === "function"
              ? String(asset.name.toString())
              : "";
          assetObj[name] = String(asset.quantity ?? "0");
        } catch {
          /* */
        }
      }
      assetsObj[policyStr] = assetObj;
    }
    return Object.keys(assetsObj).length > 0 ? JSON.stringify(assetsObj) : null;
  } catch {
    return null;
  }
}

function lovelaceFromOutput(output) {
  try {
    if (output?.value?.lovelaces != null) return String(output.value.lovelaces);
    if (output?.value?.coin != null) return String(output.value.coin);
  } catch {
    /* */
  }
  return "0";
}

function lookupOutAddress(prevTxHash, prevIdx) {
  // Prefer mb_tx_out already written (chronological ASC)
  try {
    const row = db
      .prepare(
        `SELECT address FROM mb_tx_out
         WHERE tx_hash = ? AND output_index = ? LIMIT 1`,
      )
      .get(prevTxHash, prevIdx);
    if (row?.address && String(row.address).length > 8) {
      return String(row.address);
    }
  } catch {
    /* */
  }
  // Live UTxO set if still unspent
  try {
    const ref = `${prevTxHash}:${prevIdx}`;
    const row = db
      .prepare(`SELECT tx_out FROM utxo WHERE utxo_ref = ? LIMIT 1`)
      .get(ref);
    if (row?.tx_out) {
      const j =
        typeof row.tx_out === "string" ? JSON.parse(row.tx_out) : row.tx_out;
      const a = j?.address != null ? String(j.address) : "";
      if (a.length > 8) return a;
    }
  } catch {
    /* */
  }
  return "";
}

let where =
  "block_fetch_RawCbor IS NOT NULL AND length(block_fetch_RawCbor) > 32";
const params = [];
if (fromSlot != null && Number.isFinite(fromSlot)) {
  where += " AND slot >= ?";
  params.push(fromSlot);
}
if (toSlot != null && Number.isFinite(toSlot)) {
  where += " AND slot <= ?";
  params.push(toSlot);
}

const sql = `
  SELECT slot, hash, block_fetch_RawCbor
  FROM blocks
  WHERE ${where}
  ORDER BY slot ASC
  ${limit != null && Number.isFinite(limit) ? `LIMIT ${Math.max(1, limit | 0)}` : ""}
`;

const rows = db.prepare(sql).all(...params);
console.log("blocks to scan:", rows.length);

const insertMbTx = dryRun
  ? null
  : db.prepare(`
    INSERT INTO mb_tx (
      tx_hash, block_hash, slot, tx_index, fee, size,
      invalid_before, invalid_hereafter
    ) VALUES (
      $tx_hash, $block_hash, $slot, $tx_index, $fee, $size,
      $invalid_before, $invalid_hereafter
    )
    ON CONFLICT(tx_hash) DO UPDATE SET
      block_hash = excluded.block_hash,
      slot = excluded.slot,
      tx_index = excluded.tx_index,
      fee = excluded.fee,
      size = excluded.size,
      invalid_before = excluded.invalid_before,
      invalid_hereafter = excluded.invalid_hereafter
  `);

const insertMbBlockTx = dryRun
  ? null
  : db.prepare(`
    INSERT INTO mb_block_tx (block_hash, tx_hash, tx_index)
    VALUES ($block_hash, $tx_hash, $tx_index)
    ON CONFLICT(block_hash, tx_hash) DO UPDATE SET tx_index = excluded.tx_index
  `);

const insertMbTxIn = dryRun
  ? null
  : db.prepare(`
    INSERT INTO mb_tx_in (tx_hash, input_index, prev_tx_hash, prev_output_index)
    VALUES ($tx_hash, $input_index, $prev_tx_hash, $prev_output_index)
    ON CONFLICT(tx_hash, input_index) DO UPDATE SET
      prev_tx_hash = excluded.prev_tx_hash,
      prev_output_index = excluded.prev_output_index
  `);

const insertMbTxOut = dryRun
  ? null
  : db.prepare(`
    INSERT INTO mb_tx_out (
      tx_hash, output_index, address, lovelace, assets_json,
      datum_hash, script_ref_hash, spent_by_tx, spent_at_slot
    ) VALUES (
      $tx_hash, $output_index, $address, $lovelace, $assets_json,
      NULL, NULL, NULL, NULL
    )
    ON CONFLICT(tx_hash, output_index) DO UPDATE SET
      address = excluded.address,
      lovelace = excluded.lovelace,
      assets_json = excluded.assets_json
  `);

const markSpent = dryRun
  ? null
  : db.prepare(`
    UPDATE mb_tx_out
    SET spent_by_tx = $spent_by, spent_at_slot = $slot
    WHERE tx_hash = $prev_tx AND output_index = $prev_idx
  `);

const insertMbAddr = dryRun
  ? null
  : db.prepare(`
    INSERT INTO mb_address_tx (address, tx_hash, slot, tx_index, direction)
    VALUES ($address, $tx_hash, $slot, $tx_index, $direction)
    ON CONFLICT(address, tx_hash) DO UPDATE SET
      slot = excluded.slot,
      tx_index = excluded.tx_index,
      direction = CASE
        WHEN mb_address_tx.direction = excluded.direction THEN mb_address_tx.direction
        ELSE 'both'
      END
  `);

const updateCursor = dryRun
  ? null
  : db.prepare(`
    UPDATE mb_cursor SET
      tip_slot = MAX(tip_slot, $slot),
      tip_hash = $block_hash,
      updated_at = strftime('%s','now')
    WHERE id = 1
  `);

const insertLegacyTx = dryRun || !dualLegacy
  ? null
  : db.prepare(`
    INSERT INTO tx_index (tx_hash, block_hash, slot, fee, size, invalid_hereafter, invalid_before)
    VALUES ($tx_hash, $block_hash, $slot, $fee, $size, $invalid_hereafter, $invalid_before)
    ON CONFLICT(tx_hash) DO UPDATE SET
      block_hash = excluded.block_hash,
      slot = excluded.slot,
      fee = excluded.fee,
      size = excluded.size,
      invalid_hereafter = excluded.invalid_hereafter,
      invalid_before = excluded.invalid_before
  `);

const insertLegacyAddr = dryRun || !dualLegacy
  ? null
  : db.prepare(`
    INSERT INTO address_tx (address, tx_hash, slot, direction)
    VALUES ($address, $tx_hash, $slot, $direction)
    ON CONFLICT(address, tx_hash) DO UPDATE SET
      slot = excluded.slot,
      direction = CASE
        WHEN address_tx.direction = excluded.direction THEN address_tx.direction
        ELSE 'both'
      END
  `);

const insertLegacyBlockTx = dryRun || !dualLegacy
  ? null
  : db.prepare(`
    INSERT INTO block_tx (block_hash, tx_hash, tx_index)
    VALUES ($block_hash, $tx_hash, $tx_index)
    ON CONFLICT(block_hash, tx_hash) DO UPDATE SET tx_index = excluded.tx_index
  `);

const begin = dryRun ? () => {} : () => db.exec("BEGIN");
const commit = dryRun ? () => {} : () => db.exec("COMMIT");
const rollback = dryRun
  ? () => {}
  : () => {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* */
      }
    };

let blocksOk = 0;
let blocksFail = 0;
let txCount = 0;
let outCount = 0;
let inCount = 0;
let addrCount = 0;
let lastSlot = fromSlot;
const t0 = Date.now();

const BATCH = 25;
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const slot = Number(row.slot);
  const blockHashHex =
    typeof row.hash === "string"
      ? row.hash.toLowerCase()
      : hashToHex(row.hash);
  const blockHashBlob = asU8(row.hash) ?? asU8(blockHashHex);

  if (i % BATCH === 0) begin();
  try {
    const meb = parseBlockBody(row.block_fetch_RawCbor);
    if (!meb) {
      blocksFail++;
    } else {
      const bodies = extractTxs(meb);
      let idx = 0;
      for (const txBody of bodies) {
        if (!txBody || typeof txBody !== "object") continue;
        const txHash = hashToHex(txBody.hash);
        if (!txHash || txHash.length < 64) {
          idx++;
          continue;
        }

        let fee = null;
        try {
          if (txBody.fee != null) fee = String(txBody.fee);
        } catch {
          /* */
        }
        let size = null;
        try {
          if (typeof txBody.toCborBytes === "function") {
            size = txBody.toCborBytes().length;
          }
        } catch {
          /* */
        }
        let invalidHereafter = null;
        let invalidBefore = null;
        try {
          if (txBody.ttl != null) invalidHereafter = String(txBody.ttl);
          if (txBody.validityIntervalStart != null) {
            invalidBefore = String(txBody.validityIntervalStart);
          }
        } catch {
          /* */
        }

        const addrDirs = new Map(); // address → in|out|both

        // Inputs
        const inputs = Array.isArray(txBody.inputs) ? txBody.inputs : [];
        for (let ii = 0; ii < inputs.length; ii++) {
          const input = inputs[ii];
          let prevHash = "";
          let prevIdx = 0;
          try {
            prevHash = hashToHex(
              input?.utxoRef?.id ?? input?.transaction_id ?? input?.txId,
            );
            prevIdx = Number(
              input?.utxoRef?.index ?? input?.index ?? input?.outputIndex ?? 0,
            );
          } catch {
            continue;
          }
          if (!prevHash || prevHash.length < 64) continue;

          if (!dryRun) {
            insertMbTxIn.run({
              $tx_hash: txHash,
              $input_index: ii,
              $prev_tx_hash: prevHash,
              $prev_output_index: prevIdx,
            });
            markSpent.run({
              $spent_by: txHash,
              $slot: slot,
              $prev_tx: prevHash,
              $prev_idx: prevIdx,
            });
          }
          inCount++;

          const spentAddr = lookupOutAddress(prevHash, prevIdx);
          if (spentAddr) {
            const prev = addrDirs.get(spentAddr);
            addrDirs.set(
              spentAddr,
              prev === "in" || prev === "both" ? "both" : "out",
            );
          }
        }

        // Outputs
        const outputs = Array.isArray(txBody.outputs) ? txBody.outputs : [];
        for (let oi = 0; oi < outputs.length; oi++) {
          const output = outputs[oi];
          const addr = addrToString(output?.address ?? output?.addr);
          const lovelace = lovelaceFromOutput(output);
          const assetsJson = assetsJsonFromOutput(output);

          if (!dryRun) {
            insertMbTxOut.run({
              $tx_hash: txHash,
              $output_index: oi,
              $address: addr || "",
              $lovelace: lovelace,
              $assets_json: assetsJson,
            });
          }
          outCount++;

          if (addr && addr.length > 8) {
            const prev = addrDirs.get(addr);
            addrDirs.set(
              addr,
              prev === "out" || prev === "both" ? "both" : "in",
            );
          }
        }

        if (!dryRun) {
          insertMbTx.run({
            $tx_hash: txHash,
            $block_hash: blockHashBlob,
            $slot: slot,
            $tx_index: idx,
            $fee: fee,
            $size: size,
            $invalid_before: invalidBefore,
            $invalid_hereafter: invalidHereafter,
          });
          insertMbBlockTx.run({
            $block_hash: blockHashBlob,
            $tx_hash: txHash,
            $tx_index: idx,
          });
          if (insertLegacyTx) {
            insertLegacyTx.run({
              $tx_hash: txHash,
              $block_hash: blockHashBlob,
              $slot: slot,
              $fee: fee,
              $size: size,
              $invalid_hereafter: invalidHereafter,
              $invalid_before: invalidBefore,
            });
          }
          if (insertLegacyBlockTx) {
            insertLegacyBlockTx.run({
              $block_hash: blockHashBlob,
              $tx_hash: txHash,
              $tx_index: idx,
            });
          }
        }
        txCount++;

        for (const [address, direction] of addrDirs) {
          if (!address || address.length < 10) continue;
          if (!dryRun) {
            insertMbAddr.run({
              $address: address,
              $tx_hash: txHash,
              $slot: slot,
              $tx_index: idx,
              $direction: direction,
            });
            if (insertLegacyAddr) {
              insertLegacyAddr.run({
                $address: address,
                $tx_hash: txHash,
                $slot: slot,
                $direction: direction,
              });
            }
          }
          addrCount++;
        }
        idx++;
      }
      blocksOk++;
      lastSlot = slot;
      if (!dryRun && updateCursor) {
        updateCursor.run({
          $slot: slot,
          $block_hash: blockHashBlob,
        });
      }
    }
  } catch (e) {
    blocksFail++;
    if (blocksFail <= 5) {
      console.warn(
        "block fail slot",
        slot,
        String(e?.message || e).slice(0, 120),
      );
    }
  }

  if (i % BATCH === BATCH - 1 || i === rows.length - 1) {
    try {
      commit();
    } catch (e) {
      rollback();
      console.error("commit fail", e?.message || e);
    }
  }

  if ((i + 1) % progressEvery === 0 || i === rows.length - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `progress ${i + 1}/${rows.length} ok=${blocksOk} fail=${blocksFail} txs=${txCount} outs=${outCount} ins=${inCount} addrs=${addrCount} lastSlot=${lastSlot} ${elapsed}s`,
    );
  }
}

if (!dryRun) {
  const cTx = db.prepare("SELECT COUNT(*) AS c FROM mb_tx").get().c;
  const cOut = db.prepare("SELECT COUNT(*) AS c FROM mb_tx_out").get().c;
  const cIn = db.prepare("SELECT COUNT(*) AS c FROM mb_tx_in").get().c;
  const cAddr = db.prepare("SELECT COUNT(*) AS c FROM mb_address_tx").get().c;
  const cBt = db.prepare("SELECT COUNT(*) AS c FROM mb_block_tx").get().c;
  const cur = db.prepare("SELECT tip_slot FROM mb_cursor WHERE id = 1").get();
  console.log("DONE", {
    mb_tx: cTx,
    mb_tx_out: cOut,
    mb_tx_in: cIn,
    mb_address_tx: cAddr,
    mb_block_tx: cBt,
    mb_cursor: cur?.tip_slot ?? null,
    dryRun,
  });
} else {
  console.log("DONE dry-run", {
    blocksOk,
    blocksFail,
    txCount,
    outCount,
    inCount,
    addrCount,
  });
}

db.close();
