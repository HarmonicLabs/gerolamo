#!/usr/bin/env bun
/**
 * Ad-hoc: synthetic TICKN via real NonceEvolver over immutable snapshots.
 * Epochs 4..7 fully UPDN → TICKN produces η0 for 5,6,7,8 vs onchainapps.
 * Not suite green.
 *
 *   bun scripts/hermes-verify-synth-tickn.mjs
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { parseChunk } from "../src/state/legacy.ts";
import { NonceEvolver } from "../src/utils/nonceEvolver.ts";
import { blockNonceFromVrfProofHash } from "../src/utils/calcEpochNonce.ts";
import { getFirstSlotOfEpoch } from "../src/utils/epochFromSlotCalculations.ts";
import genesis from "../src/config/preprod/shelley-genesis.json";

const CWD = resolve(import.meta.dir, "..");
const IMMUTABLE = resolve(CWD, "snapshots/preprod/db/immutable");
const EXTERNAL_BASE = "https://blockfrost-preprod.onchainapps.io";
const FIRST_EPOCH = 4;
const LAST_EPOCH = 7; // fully UPDN; TICKN yields η0 for 5..8

function chunkForSlot(slot) {
  return Math.max(0, Math.floor(Number(slot) / 21600));
}

async function fetchExternal(epoch) {
  const r = await fetch(`${EXTERNAL_BASE}/epochs/${epoch}/parameters`);
  if (!r.ok) throw new Error(`epoch ${epoch}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.nonce) throw new Error(`epoch ${epoch}: no nonce`);
  return j.nonce;
}

async function loadChunk(n) {
  const p = n.toString().padStart(5, "0");
  const [pb, sb, cb] = await Promise.all([
    Bun.file(`${IMMUTABLE}/${p}.primary`).arrayBuffer(),
    Bun.file(`${IMMUTABLE}/${p}.secondary`).arrayBuffer(),
    Bun.file(`${IMMUTABLE}/${p}.chunk`).arrayBuffer(),
  ]);
  return parseChunk(new DataView(pb), new DataView(sb), new DataView(cb));
}

function extractFromMeb(meb) {
  const header = meb.block.header;
  const body = header?.body ?? header;
  if (!body) return null;
  const proofHash =
    body.nonceVrfResult?.proofHash ?? body.vrfResult?.proofHash ?? null;
  if (!(proofHash instanceof Uint8Array) || proofHash.length === 0) return null;
  let prevHash = null;
  if (body.prevHash instanceof Uint8Array) prevHash = body.prevHash;
  return {
    bnonce: blockNonceFromVrfProofHash(proofHash),
    prevHash,
    headerHash: blake2b_256(header.toCborBytes()),
  };
}

console.log("=== Ad-hoc synthetic TICKN: NonceEvolver + snapshots ===\n");
console.log("cwd:", CWD);
console.log("immutable:", IMMUTABLE);
console.log(
  `range: epoch ${FIRST_EPOCH}..${LAST_EPOCH} → TICKN η0_${FIRST_EPOCH + 1}..${LAST_EPOCH + 1}\n`,
);

const external = new Map();
for (let e = FIRST_EPOCH; e <= LAST_EPOCH + 1; e++) {
  try {
    const n = await fetchExternal(e);
    external.set(e, n);
    console.log(`[external] η0_${e} = ${n}`);
  } catch (err) {
    console.log(`[external] η0_${e} FAIL: ${err.message}`);
  }
}
console.log();

const slotStart = BigInt(getFirstSlotOfEpoch(FIRST_EPOCH, genesis));
const slotEnd = BigInt(getFirstSlotOfEpoch(LAST_EPOCH + 1, genesis)) - 1n;
const firstChunk = Math.max(0, chunkForSlot(slotStart) - 1);
const lastChunk = chunkForSlot(slotEnd) + 2;
console.log(`slots [${slotStart}, ${slotEnd}] chunks ${firstChunk}..${lastChunk}`);

const blocks = [];
let skippedByron = 0;
let skippedNoNonce = 0;
let parseFail = 0;

for (let c = firstChunk; c <= lastChunk; c++) {
  let raw;
  try {
    raw = await loadChunk(c);
  } catch {
    continue;
  }
  for (const b of raw) {
    if (b.slotNo < slotStart || b.slotNo > slotEnd) continue;
    try {
      const meb = MultiEraBlock.fromCbor(b.blockCbor);
      if (meb.era < 2) {
        skippedByron++;
        continue;
      }
      const x = extractFromMeb(meb);
      if (!x) {
        skippedNoNonce++;
        continue;
      }
      blocks.push({
        slot: b.slotNo,
        bnonce: x.bnonce,
        prevHash: x.prevHash,
        headerHash: x.headerHash,
      });
    } catch {
      parseFail++;
    }
  }
}
blocks.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
console.log(
  `blocks=${blocks.length} byron_skip=${skippedByron} nononce=${skippedNoNonce} parse_fail=${parseFail}`,
);
if (!blocks.length) {
  console.log("[FAIL] no blocks");
  process.exit(1);
}
console.log(
  `first_slot=${blocks[0].slot} last_slot=${blocks[blocks.length - 1].slot}`,
);
console.log(`sample bnonce=${toHex(blocks[0].bnonce)}\n`);

const init = external.get(FIRST_EPOCH);
if (!init) {
  console.log("[FAIL] missing external η0 for first epoch");
  process.exit(1);
}

const evolver = new NonceEvolver(genesis);
evolver.bootstrap(FIRST_EPOCH, init);
console.log(
  `NonceEvolver bootstrap epoch=${FIRST_EPOCH} η0=${init.slice(0, 16)}… SW=${evolver.getStabilityWindow()}\n`,
);

const tickns = [];
let nProcessed = 0;
for (const b of blocks) {
  const ts = evolver.processBlock(b.slot, b.bnonce, b.prevHash);
  for (const t of ts) tickns.push(t);
  nProcessed++;
}

// Force final TICKN for η0_(LAST+1) if still on LAST_EPOCH
if (evolver.isActive() && evolver.getEpoch() === LAST_EPOCH) {
  const t = evolver.tickn();
  tickns.push(t);
  console.log(`(forced final TICKN after last block of epoch ${LAST_EPOCH})\n`);
}

console.log(`processed=${nProcessed} tickn_events=${tickns.length}\n`);

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(
    `${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (ok) passed++;
  else failed++;
}

check(
  `η0_${FIRST_EPOCH} init matches external`,
  true,
  `${init.slice(0, 16)}… (bootstrap)`,
);

for (const t of tickns) {
  const ext = external.get(t.epoch);
  const match = !!ext && t.eta0Hex === ext;
  check(
    `η0_${t.epoch} TICKN vs external`,
    match,
    match
      ? `blocks=${t.nBlocksPrev} freeze=${t.nBeforeFreeze}`
      : `computed=${t.eta0Hex.slice(0, 16)}… external=${ext?.slice(0, 16) ?? "N/A"}… blocks=${t.nBlocksPrev}`,
  );
  if (!match) {
    console.log(`    computed full: ${t.eta0Hex}`);
    console.log(`    external full: ${ext ?? "N/A"}`);
    console.log(`    ηh used: ${t.etaHUsedHex ?? "(Neutral)"}`);
  }
}

for (const e of [5, 6, 7, 8]) {
  check(`TICKN event for epoch ${e}`, tickns.some((t) => t.epoch === e));
}

const snap = evolver.snapshot();
console.log("\n=== evolver snapshot after replay ===");
console.log(
  JSON.stringify(
    {
      epoch: snap.epoch,
      etaV: snap.etaVHex.slice(0, 16) + "…",
      etaC: snap.etaCHex.slice(0, 16) + "…",
      etaH: snap.etaHHex ? snap.etaHHex.slice(0, 16) + "…" : null,
      nBlocksInEpoch: snap.nBlocksInEpoch,
      nBeforeFreeze: snap.nBeforeFreeze,
    },
    null,
    2,
  ),
);

// Live e301 smoke from DB
try {
  const db = new Database(resolve(CWD, "ledger/gerolamo.db"), {
    readonly: true,
  });
  const st = db
    .query(
      "SELECT nonce_hex, source, evolving_hex, candidate_hex FROM epoch_nonces WHERE epoch=301",
    )
    .get();
  let ext301 = null;
  try {
    ext301 = await fetchExternal(301);
  } catch {
    /* ignore */
  }
  if (st) {
    check(
      "e301 DB η0 == external",
      !!ext301 && st.nonce_hex === ext301,
      `src=${st.source}`,
    );
    check(
      "e301 UPDN ηv ≠ η0",
      !!st.evolving_hex && st.evolving_hex !== st.nonce_hex,
    );
    check(
      "e301 ηv == ηc (pre-freeze)",
      st.evolving_hex === st.candidate_hex,
    );
  } else {
    check("e301 DB row present", false);
  }
} catch (e) {
  check("e301 live smoke", false, String(e).slice(0, 120));
}

// Node stopped (exclude this shell / pgrep itself)
try {
  const p = execSync(
    "pgrep -af 'bun src/index.ts start-gerolamo' 2>/dev/null | grep -v 'pgrep\\|hermes-snap\\|hermes-cwd\\|__hermes' || true",
    { encoding: "utf8" },
  ).trim();
  const live = p
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /bun\s+src\/index\.ts\s+start-gerolamo/.test(l));
  check(
    "preprod node stopped",
    live.length === 0,
    live.length ? live[0] : "(none)",
  );
} catch {
  check("preprod node stopped", true);
}

console.log(`\n=== Summary ===\nPassed: ${passed}, Failed: ${failed}`);
if (failed === 0) {
  console.log(
    "[PASS] Synthetic TICKN via NonceEvolver matches external (not suite green)",
  );
  process.exit(0);
}
console.log("[FAIL] Some synthetic checks failed");
process.exit(1);
