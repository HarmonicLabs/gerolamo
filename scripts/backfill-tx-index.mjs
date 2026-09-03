#!/usr/bin/env bun
/**
 * Off-hot-path Mini-BF index backfill.
 *
 * Populates tx_index / address_tx / block_tx from stored block bodies.
 * NEVER run against soak batch.db while hydrate is writing — default is .live/test.db.
 *
 * Usage:
 *   bun scripts/backfill-tx-index.mjs
 *   bun scripts/backfill-tx-index.mjs --db .live/test.db
 *   bun scripts/backfill-tx-index.mjs --db .live/test.db --from-slot 1000 --limit 200
 *   bun scripts/backfill-tx-index.mjs --db .live/test.db --wipe-index
 *
 * Parse path (same as live BlockFetch):
 *   BlockFetchBlock.fromCbor(raw) → MultiEraBlock.fromCbor(blockData) → transactionBodies
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const WORKDIR = resolve(import.meta.dir, "..");
const DB_PATH = resolve(arg("db", resolve(WORKDIR, ".live/test.db")));
const fromSlot = arg("from-slot", null) != null ? Number(arg("from-slot")) : null;
const toSlot = arg("to-slot", null) != null ? Number(arg("to-slot")) : null;
const limit = arg("limit", null) != null ? Number(arg("limit")) : null;
const progressEvery = Number(arg("progress", "50"));
const wipeIndex = hasFlag("wipe-index");
const dryRun = hasFlag("dry-run");

// Safety: refuse default soak path unless explicitly forced
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

console.log("backfill-tx-index", {
  db: DB_PATH,
  fromSlot,
  toSlot,
  limit,
  wipeIndex,
  dryRun,
});

const db = new Database(DB_PATH, dryRun ? { readonly: true } : undefined);
db.exec("PRAGMA busy_timeout=10000");
if (!dryRun) {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
}

// Ensure schema (same as src/db.ts init)
if (!dryRun) {
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
  if (wipeIndex) {
    db.exec("DELETE FROM tx_index; DELETE FROM address_tx; DELETE FROM block_tx;");
    console.log("wiped index tables");
  }
}

function asU8(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === "string") {
    // hex hash stored as text
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
  // Prefer BlockFetch wrapper (live path)
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
  // Byron payloads — best-effort
  const payload = any?.body?.txPayload;
  if (Array.isArray(payload)) {
    return payload.map((entry) => entry?.transaction ?? entry?.tx ?? entry?.body ?? entry);
  }
  return [];
}

function extractAddrs(txBody) {
  const addrs = new Map(); // addr -> direction
  const outs = Array.isArray(txBody?.outputs) ? txBody.outputs : [];
  for (const o of outs) {
    const a = addrToString(o?.address ?? o?.addr);
    if (a && a.length > 8) {
      const prev = addrs.get(a);
      addrs.set(a, prev === "out" || prev === "both" ? "both" : prev === "in" ? "both" : "in");
    }
  }
  // inputs don't carry address in body; skip spend-side without UTxO join (v1 honest limit)
  return addrs;
}

let where = "block_data IS NOT NULL AND length(block_data) > 32";
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
  SELECT slot, hash, block_data
  FROM blocks
  WHERE ${where}
  ORDER BY slot ASC
  ${limit != null && Number.isFinite(limit) ? `LIMIT ${Math.max(1, limit | 0)}` : ""}
`;

const rows = db.prepare(sql).all(...params);
console.log("blocks to scan:", rows.length);

const insertTx = dryRun
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

const insertAddr = dryRun
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

const insertBlockTx = dryRun
  ? null
  : db.prepare(`
    INSERT INTO block_tx (block_hash, tx_hash, tx_index)
    VALUES ($block_hash, $tx_hash, $tx_index)
    ON CONFLICT(block_hash, tx_hash) DO UPDATE SET tx_index = excluded.tx_index
  `);

const begin = dryRun ? () => {} : () => db.exec("BEGIN");
const commit = dryRun ? () => {} : () => db.exec("COMMIT");
const rollback = dryRun ? () => {} : () => {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* */
  }
};

let blocksOk = 0;
let blocksFail = 0;
let txCount = 0;
let addrCount = 0;
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
    const meb = parseBlockBody(row.block_data);
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

        if (!dryRun) {
          insertTx.run({
            $tx_hash: txHash,
            $block_hash: blockHashBlob,
            $slot: slot,
            $fee: fee,
            $size: size,
            $invalid_hereafter: invalidHereafter,
            $invalid_before: invalidBefore,
          });
          insertBlockTx.run({
            $block_hash: blockHashBlob,
            $tx_hash: txHash,
            $tx_index: idx,
          });
        }
        txCount++;

        const addrs = extractAddrs(txBody);
        for (const [address, direction] of addrs) {
          if (!dryRun) {
            insertAddr.run({
              $address: address,
              $tx_hash: txHash,
              $slot: slot,
              $direction: direction,
            });
          }
          addrCount++;
        }
        idx++;
      }
      blocksOk++;
    }
  } catch (e) {
    blocksFail++;
    if (blocksFail <= 5) {
      console.warn("block fail slot", slot, String(e?.message || e).slice(0, 120));
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
      `progress ${i + 1}/${rows.length} ok=${blocksOk} fail=${blocksFail} txs=${txCount} addrs=${addrCount} ${elapsed}s`,
    );
  }
}

if (!dryRun) {
  const cTx = db.prepare("SELECT COUNT(*) AS c FROM tx_index").get().c;
  const cAddr = db.prepare("SELECT COUNT(*) AS c FROM address_tx").get().c;
  const cBt = db.prepare("SELECT COUNT(*) AS c FROM block_tx").get().c;
  console.log("DONE", { tx_index: cTx, address_tx: cAddr, block_tx: cBt, dryRun });
} else {
  console.log("DONE dry-run", { blocksOk, blocksFail, txCount, addrCount });
}

db.close();
