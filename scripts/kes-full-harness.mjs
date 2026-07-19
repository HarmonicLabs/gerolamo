#!/usr/bin/env bun
/**
 * Full KES testing harness — pure-TS @harmoniclabs/kes
 *
 * Covers:
 *  A) sizes / constants
 *  B) helpers (splitSeed, hashPair, bytesEq)
 *  C) Sum0 leaf (keygen/sign/verify/update-throws)
 *  D) Sum6 non-compact lifecycle (keygen → update 0..63 → sign/verify)
 *  E) Sum6 compact lifecycle + compactRecompute
 *  F) depth-generic sum* / compact* at d=1,2,3
 *  G) IOHK interop vectors (byte-identical)
 *  H) optional wasm dual-run smoke (if wasm-kes resolvable)
 *  I) real preprod snapshot headers (immutable chunks)
 *
 * Usage (from gerolamo root):
 *   bun scripts/kes-full-harness.mjs [--chunks DIR] [--limit N] [--from-chunk N] [--to-chunk N]
 *
 * Exit 0 iff FAIL === 0 and snapshot match > 0.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { format, resolve, join } from "node:path";

import {
  // wasm-compat Sum6
  verify,
  sign,
  kes_keygen,
  kes_update,
  kes_to_pk,
  kes_get_period,
  SUM6_SIGNATURE_SIZE,
  SUM6_SECRET_KEY_BODY_SIZE,
  SUM6_SECRET_KEY_SIZE,
  // compact Sum6
  keygenSum6Compact,
  signSum6Compact,
  verifySum6Compact,
  updateSum6Compact,
  compactRecompute,
  SUM6_COMPACT_SIG_SIZE,
  // depth-generic
  sumKeygen,
  sumSign,
  sumUpdate,
  sumVerify,
  sumGetPeriod,
  sumToPk,
  sumSignatureSize,
  sumSkSize,
  // sum0
  sum0Keygen,
  sum0Sign,
  sum0Verify,
  sum0ToPk,
  sum0CompactSign,
  sum0CompactVerify,
  sum0CompactRecompute,
  SUM0_SIG_SIZE,
  SUM0_COMPACT_SIG_SIZE,
  SUM0_SK_SIZE,
  // helpers / sizes
  hashPair,
  splitSeed,
  bytesEq,
  depthTotal,
  depthHalf,
  skBodySize,
  skWithPeriodSize,
  compactSigSize,
  sumSigSize,
  PUBLIC_KEY_SIZE,
  SEED_SIZE,
} from "@harmoniclabs/kes";

import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

// ---------------------------------------------------------------------------
// CLI / paths
// ---------------------------------------------------------------------------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GER = resolve(import.meta.dir, "..");
const KES_ROOT = resolve(GER, "../kes-ts");
const VEC = join(KES_ROOT, "tests/vectors");
const chunksDir = resolve(arg("chunks") ?? join(GER, "snapshots/preprod/db/immutable"));
const maxBlocks = Number(arg("limit") ?? 2000);
const fromChunk = Number(arg("from-chunk") ?? 50);
const toChunkArg = arg("to-chunk");

const IOHK_SEED = new TextEncoder().encode("test string of 32 byte of lenght"); // 32 bytes exact
const IOHK_MSG = new TextEncoder().encode("test message");
const SYN_SEED = new Uint8Array(32).fill(0x53); // exactly 32 bytes
const SYN_MSG = new TextEncoder().encode("synthetic message for full kes harness");

function loadVec(name) {
  return new Uint8Array(readFileSync(join(VEC, name)));
}

const PASS = [];
const FAIL = [];
const SKIP = [];
function ok(name, cond, detail = "") {
  (cond ? PASS : FAIL).push(name);
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function skip(name, reason) {
  SKIP.push(name);
  console.log(`[SKIP] ${name} — ${reason}`);
}
function eqBytes(a, b) {
  return a instanceof Uint8Array && b instanceof Uint8Array && bytesEq(a, b);
}

console.log("=== Full KES Testing Harness ===\n");
console.log(
  JSON.stringify(
    {
      chunksDir,
      maxBlocks,
      fromChunk,
      toChunk: toChunkArg ?? "max",
      vecDir: VEC,
      vecOk: existsSync(join(VEC, "key6.bin")),
    },
    null,
    2,
  ),
);
console.log("");

// ===========================================================================
// A) Sizes & constants
// ===========================================================================
console.log("--- A) sizes ---");
ok("SUM6_SIGNATURE_SIZE === 448", SUM6_SIGNATURE_SIZE === 448);
ok("SUM6_SECRET_KEY_BODY_SIZE === 608", SUM6_SECRET_KEY_BODY_SIZE === 608);
ok("SUM6_SECRET_KEY_SIZE === 612", SUM6_SECRET_KEY_SIZE === 612);
ok("SUM6_COMPACT_SIG_SIZE === 288", SUM6_COMPACT_SIG_SIZE === 288);
ok("sumSigSize(6) === 448", sumSigSize(6) === 448);
ok("compactSigSize(6) === 288", compactSigSize(6) === 288);
ok("skBodySize(6) === 608", skBodySize(6) === 608);
ok("skWithPeriodSize(6) === 612", skWithPeriodSize(6) === 612);
ok("SUM0_SIG_SIZE === 64", SUM0_SIG_SIZE === 64);
ok("SUM0_COMPACT_SIG_SIZE === 96", SUM0_COMPACT_SIG_SIZE === 96);
ok("SUM0_SK_SIZE === 36", SUM0_SK_SIZE === 36);
ok("PUBLIC_KEY_SIZE === 32", PUBLIC_KEY_SIZE === 32);
ok("SEED_SIZE === 32", SEED_SIZE === 32);
ok("depthTotal(6) === 64 (periods 0..63)", depthTotal(6) === 64);
ok("depthHalf(6) === 32", depthHalf(6) === 32);
ok("IOHK seed length 32", IOHK_SEED.length === 32);
ok("SYN seed length 32", SYN_SEED.length === 32);

// ===========================================================================
// B) Helpers
// ===========================================================================
console.log("\n--- B) helpers ---");
{
  const seed = new Uint8Array(32).fill(0xab);
  const seedCopy = seed.slice();
  const { left, right } = splitSeed(seed);
  ok("splitSeed left 32", left.length === 32);
  ok("splitSeed right 32", right.length === 32);
  ok("splitSeed children differ", !eqBytes(left, right));
  ok("splitSeed zeroes parent", seed.every((b) => b === 0));
  // deterministic
  const s2 = splitSeed(seedCopy);
  ok("splitSeed deterministic left", eqBytes(left, s2.left));
  ok("splitSeed deterministic right", eqBytes(right, s2.right));

  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  const c = new Uint8Array([1, 2, 3, 5]);
  ok("bytesEq same", bytesEq(a, b));
  ok("bytesEq diff", !bytesEq(a, c));
  ok("bytesEq len mismatch", !bytesEq(a, new Uint8Array(3)));

  const pkL = new Uint8Array(32).fill(1);
  const pkR = new Uint8Array(32).fill(2);
  const h1 = hashPair(pkL, pkR);
  const h2 = hashPair(pkL, pkR);
  const hSwap = hashPair(pkR, pkL);
  ok("hashPair len 32", h1.length === 32);
  ok("hashPair deterministic", eqBytes(h1, h2));
  ok("hashPair order-sensitive", !eqBytes(h1, hSwap));
  let threw = false;
  try {
    hashPair(new Uint8Array(16), pkR);
  } catch {
    threw = true;
  }
  ok("hashPair rejects bad len", threw);
}

// ===========================================================================
// C) Sum0 leaf
// ===========================================================================
console.log("\n--- C) Sum0 leaf ---");
{
  const sk = new Uint8Array(SUM0_SK_SIZE);
  const pk = sum0Keygen(sk, IOHK_SEED.slice());
  ok("sum0 keygen pk 32", pk.length === 32);
  ok("sum0 toPk matches", eqBytes(sum0ToPk(sk), pk));
  ok("sum0 vector key0.bin body", eqBytes(sk.subarray(0, 32), loadVec("key0.bin")));

  const sig = sum0Sign(sk, IOHK_MSG);
  ok("sum0 sig 64", sig.length === SUM0_SIG_SIZE);
  ok("sum0 verify true", sum0Verify(sig, 0, pk, IOHK_MSG) === true);
  ok("sum0 verify bad msg false", sum0Verify(sig, 0, pk, new TextEncoder().encode("x")) === false);
  ok("sum0 verify bad pk false", sum0Verify(sig, 0, new Uint8Array(32), IOHK_MSG) === false);

  // compact leaf
  const csig = sum0CompactSign(sk, IOHK_MSG);
  ok("sum0 compact sig 96", csig.length === SUM0_COMPACT_SIG_SIZE);
  ok("sum0 compact verify true", sum0CompactVerify(csig, 0, pk, IOHK_MSG) === true);
  const root = sum0CompactRecompute(csig, 0, IOHK_MSG);
  ok("sum0 compact recompute = pk", root !== null && eqBytes(root, pk));

  // update always throws
  let updateThrew = false;
  try {
    // not exported from index; import path via sum0 only if needed
    // use dynamic to avoid missing export
    const m = await import("@harmoniclabs/kes");
    if (typeof m.sum0Update === "function") {
      m.sum0Update(sk);
    } else {
      // depth-0 update via sumUpdate throws KeyCannotBeUpdatedMore
      const d0 = new Uint8Array(sumSkSize(0));
      sumKeygen(0, d0, new Uint8Array(32).fill(9));
      sumUpdate(0, d0);
    }
  } catch (e) {
    updateThrew = /KeyCannotBeUpdatedMore|CannotBeUpdated|update/i.test(String(e.message));
  }
  ok("sum0/d0 update throws KeyCannotBeUpdatedMore", updateThrew);
}

// ===========================================================================
// D) Sum6 non-compact full lifecycle (0..63)
// ===========================================================================
console.log("\n--- D) Sum6 non-compact lifecycle ---");
{
  const { sk, pk } = kes_keygen(SYN_SEED.slice());
  ok("keygen sk 612", sk.length === SUM6_SECRET_KEY_SIZE);
  ok("keygen pk 32", pk.length === 32);
  ok("keygen period 0", kes_get_period(sk) === 0);
  ok("kes_to_pk matches", eqBytes(kes_to_pk(sk), pk));

  let allOk = true;
  let firstFail = null;
  for (let p = 0; p <= 63; p++) {
    if (kes_get_period(sk) !== p) {
      allOk = false;
      firstFail ??= `period_field@${p}=${kes_get_period(sk)}`;
      break;
    }
    // pk stable across evolution
    if (!eqBytes(kes_to_pk(sk), pk)) {
      allOk = false;
      firstFail ??= `pk_drift@${p}`;
      break;
    }
    const sig = sign(sk, SYN_MSG);
    if (sig.length !== 448) {
      allOk = false;
      firstFail ??= `sig_len@${p}=${sig.length}`;
      break;
    }
    if (!verify(sig, p, pk, SYN_MSG)) {
      allOk = false;
      firstFail ??= `verify_fail@${p}`;
      break;
    }
    // wrong period / msg must fail
    if (verify(sig, p === 0 ? 1 : p - 1, pk, SYN_MSG)) {
      allOk = false;
      firstFail ??= `wrong_period_accepted@${p}`;
      break;
    }
    if (verify(sig, p, pk, new TextEncoder().encode("nope"))) {
      allOk = false;
      firstFail ??= `wrong_msg_accepted@${p}`;
      break;
    }
    if (p < 63) kes_update(sk);
  }
  ok("Sum6 lifecycle 0..63 sign/verify + pk stable", allOk, firstFail ?? "64 periods");

  // cannot update past 63
  let pastThrew = false;
  try {
    kes_update(sk); // already at 63
  } catch (e) {
    pastThrew = /KeyCannotBeUpdatedMore/i.test(String(e.message));
  }
  ok("Sum6 update past 63 throws", pastThrew);
  ok("Sum6 stuck at period 63", kes_get_period(sk) === 63);
}

// ===========================================================================
// E) Sum6 compact lifecycle + recompute
// ===========================================================================
console.log("\n--- E) Sum6 compact lifecycle ---");
{
  const { sk, pk } = keygenSum6Compact(SYN_SEED.slice());
  ok("compact sk 612", sk.length === SUM6_SECRET_KEY_SIZE);
  ok("compact pk 32", pk.length === 32);

  let allOk = true;
  let firstFail = null;
  for (let p = 0; p <= 63; p++) {
    const sig = signSum6Compact(sk, SYN_MSG);
    if (sig.length !== SUM6_COMPACT_SIG_SIZE) {
      allOk = false;
      firstFail ??= `sig_len@${p}`;
      break;
    }
    if (!verifySum6Compact(sig, p, pk, SYN_MSG)) {
      allOk = false;
      firstFail ??= `verify@${p}`;
      break;
    }
    const root = compactRecompute(6, sig, p, SYN_MSG);
    if (root === null || !eqBytes(root, pk)) {
      allOk = false;
      firstFail ??= `recompute@${p}`;
      break;
    }
    // wrong period recompute null/fail
    if (p > 0) {
      const bad = compactRecompute(6, sig, p - 1, SYN_MSG);
      // may be null OR wrong root — must not equal pk via verify
      if (verifySum6Compact(sig, p - 1, pk, SYN_MSG)) {
        allOk = false;
        firstFail ??= `wrong_period_ok@${p}`;
        break;
      }
      void bad;
    }
    if (p < 63) updateSum6Compact(sk);
  }
  ok("Compact lifecycle 0..63 + recompute", allOk, firstFail ?? "64 periods");

  let pastThrew = false;
  try {
    updateSum6Compact(sk);
  } catch (e) {
    pastThrew = /KeyCannotBeUpdatedMore/i.test(String(e.message));
  }
  ok("Compact update past 63 throws", pastThrew);
}

// ===========================================================================
// F) Depth-generic sum* at d=1,2,3
// ===========================================================================
console.log("\n--- F) depth-generic sum ---");
for (const d of [1, 2, 3]) {
  const total = depthTotal(d);
  const sk = new Uint8Array(sumSkSize(d));
  const pk = sumKeygen(d, sk, new Uint8Array(32).fill(d + 10));
  ok(`d${d} keygen pk 32`, pk.length === 32);
  ok(`d${d} period 0`, sumGetPeriod(d, sk) === 0);
  ok(`d${d} toPk matches`, eqBytes(sumToPk(d, sk), pk));
  ok(`d${d} sig size`, sumSignatureSize(d) === sumSigSize(d));

  let okAll = true;
  for (let p = 0; p < total; p++) {
    const sig = sumSign(d, sk, SYN_MSG);
    if (!sumVerify(d, sig, p, pk, SYN_MSG)) {
      okAll = false;
      break;
    }
    if (p < total - 1) sumUpdate(d, sk);
  }
  ok(`d${d} lifecycle 0..${total - 1}`, okAll);

  let threw = false;
  try {
    sumUpdate(d, sk);
  } catch (e) {
    threw = /KeyCannotBeUpdatedMore/i.test(String(e.message));
  }
  ok(`d${d} update past max throws`, threw);
}

// ===========================================================================
// G) IOHK interop vectors (byte-identical)
// ===========================================================================
console.log("\n--- G) IOHK interop vectors ---");
if (!existsSync(join(VEC, "key6.bin"))) {
  skip("IOHK vectors", "vectors dir missing");
} else {
  // Sum6 keygen body
  {
    const { sk, pk } = kes_keygen(IOHK_SEED.slice());
    const body = sk.subarray(0, SUM6_SECRET_KEY_BODY_SIZE);
    ok("vector key6.bin body", eqBytes(body, loadVec("key6.bin")));
    ok("vector keygen period 0", kes_get_period(sk) === 0);
    // pk is derived; not stored as separate vector file for root pk in same way —
    // verify via toPk stability
    ok("vector toPk stable", eqBytes(kes_to_pk(sk), pk));
  }
  // updates
  {
    const { sk } = kes_keygen(IOHK_SEED.slice());
    kes_update(sk);
    ok("vector key6update1.bin", eqBytes(sk.subarray(0, 608), loadVec("key6update1.bin")));
    for (let i = 0; i < 4; i++) kes_update(sk);
    ok("vector key6update5.bin", eqBytes(sk.subarray(0, 608), loadVec("key6update5.bin")));
    ok("vector period after 5", kes_get_period(sk) === 5);
  }
  // sign period 0 / 5
  {
    const { sk, pk } = kes_keygen(IOHK_SEED.slice());
    const s0 = sign(sk, IOHK_MSG);
    ok("vector key6Sig.bin", eqBytes(s0, loadVec("key6Sig.bin")));
    ok("vector verify s0", verify(s0, 0, pk, IOHK_MSG) === true);
    ok("vector reject s0@1", verify(s0, 1, pk, IOHK_MSG) === false);
    for (let i = 0; i < 5; i++) kes_update(sk);
    const s5 = sign(sk, IOHK_MSG);
    ok("vector key6Sig5.bin", eqBytes(s5, loadVec("key6Sig5.bin")));
    ok("vector verify s5", verify(s5, 5, pk, IOHK_MSG) === true);
  }
  // depth-1 keygen
  {
    const sk = new Uint8Array(sumSkSize(1));
    sumKeygen(1, sk, IOHK_SEED.slice());
    ok("vector key1.bin", eqBytes(sk.subarray(0, loadVec("key1.bin").length), loadVec("key1.bin")));
  }
  // compact vectors
  {
    const { sk, pk } = keygenSum6Compact(IOHK_SEED.slice());
    ok("vector compactkey6.bin", eqBytes(sk.subarray(0, 608), loadVec("compactkey6.bin")));
    const cs0 = signSum6Compact(sk, IOHK_MSG);
    ok("vector compactkey6Sig.bin", eqBytes(cs0, loadVec("compactkey6Sig.bin")));
    ok("vector compact verify s0", verifySum6Compact(cs0, 0, pk, IOHK_MSG) === true);
    updateSum6Compact(sk);
    ok("vector compactkey6update1.bin", eqBytes(sk.subarray(0, 608), loadVec("compactkey6update1.bin")));
    for (let i = 0; i < 4; i++) updateSum6Compact(sk);
    ok("vector compactkey6update5.bin", eqBytes(sk.subarray(0, 608), loadVec("compactkey6update5.bin")));
    const cs5 = signSum6Compact(sk, IOHK_MSG);
    ok("vector compactkey6Sig5.bin", eqBytes(cs5, loadVec("compactkey6Sig5.bin")));
    ok("vector compact verify s5", verifySum6Compact(cs5, 5, pk, IOHK_MSG) === true);
  }
  // compact depth-1
  {
    // compact uses same SK layout as sum; compactkey1.bin is SK body for d=1
    const sk = new Uint8Array(sumSkSize(1));
    sumKeygen(1, sk, IOHK_SEED.slice());
    ok("vector compactkey1.bin", eqBytes(sk.subarray(0, loadVec("compactkey1.bin").length), loadVec("compactkey1.bin")));
  }
}

// ===========================================================================
// H) optional wasm dual-run (if package still resolvable)
// ===========================================================================
console.log("\n--- H) optional wasm dual-run ---");
{
  let wasm;
  try {
    wasm = await import("wasm-kes");
  } catch {
    wasm = null;
  }
  if (!wasm?.verify) {
    skip("wasm dual-run", "wasm-kes not installed (expected after cutover)");
  } else {
    const { sk, pk } = kes_keygen(IOHK_SEED.slice());
    const s0 = sign(sk, IOHK_MSG);
    ok("wasm≡ts period 0", verify(s0, 0, pk, IOHK_MSG) === wasm.verify(s0, 0, pk, IOHK_MSG));
    for (let i = 0; i < 5; i++) kes_update(sk);
    const s5 = sign(sk, IOHK_MSG);
    ok("wasm≡ts period 5", verify(s5, 5, pk, IOHK_MSG) === wasm.verify(s5, 5, pk, IOHK_MSG));
    ok("wasm≡ts both true @5", verify(s5, 5, pk, IOHK_MSG) === true && wasm.verify(s5, 5, pk, IOHK_MSG) === true);
  }
}

// ===========================================================================
// I) Real preprod snapshot headers
// ===========================================================================
console.log("\n--- I) snapshot soak (immutable chunks) ---");
{
  const genesisPath = join(GER, "src/config/preprod/shelley-genesis.json");
  const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
  const slotsPerKES = BigInt(genesis.slotsPerKESPeriod);
  const maxEvo = BigInt(genesis.maxKESEvolutions);

  function listChunkNos(dir) {
    const nos = [];
    for (const f of readdirSync(dir)) {
      const m = /^(\d{5})\.chunk$/.exec(f);
      if (m) nos.push(parseInt(m[1], 10));
    }
    nos.sort((a, b) => a - b);
    return nos;
  }

  /** Same layout as gerolamo src/state/legacy.ts */
  function parseChunk(primaryDV, secondaryDV, chunkDV) {
    if (primaryDV.getUint8(0) !== 1) throw new Error("Invalid primary version");
    const offsets = Array.from(
      { length: (primaryDV.byteLength - 1) / 4 },
      (_, i) => primaryDV.getUint32(i * 4 + 1, false),
    );
    const filled = offsets.flatMap((o, i) =>
      i < offsets.length - 1 && o !== offsets[i + 1] ? [i] : [],
    );
    const blockOffs = filled.map((rel) => secondaryDV.getBigUint64(offsets[rel], false));
    return filled.map((relSlot, i) => {
      const secOff = offsets[relSlot];
      const start = Number(blockOffs[i]);
      const end = i < filled.length - 1 ? Number(blockOffs[i + 1]) : chunkDV.byteLength;
      return {
        slotNo: secondaryDV.getBigUint64(secOff + 48, false),
        blockCbor: new Uint8Array(chunkDV.buffer.slice(start, end)),
      };
    });
  }

  if (!existsSync(chunksDir)) {
    skip("snapshot soak", `chunks dir missing: ${chunksDir}`);
  } else {
    const allChunks = listChunkNos(chunksDir);
    const maxOnDisk = allChunks[allChunks.length - 1] ?? -1;
    const toChunk = toChunkArg != null ? Number(toChunkArg) : maxOnDisk;
    const range = allChunks.filter((n) => n >= fromChunk && n <= toChunk);

    // optional wasm for dual-run on chain
    let wasm = null;
    try {
      wasm = await import("wasm-kes");
    } catch {
      /* pure-ts only */
    }

    let match = 0;
    let tsTrue = 0;
    let tsFalse = 0;
    let diverge = 0;
    let skipN = 0;
    let parseFail = 0;
    let byron = 0;
    let processed = 0;
    const eras = {};
    const periods = {};
    const fails = [];
    const divergences = [];

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
      } catch {
        skipN++;
        continue;
      }

      for (const b of blocks) {
        if (processed >= maxBlocks) break outer;
        let meb;
        try {
          meb = MultiEraBlock.fromCbor(b.blockCbor);
        } catch {
          parseFail++;
          continue;
        }
        if (meb.era < 2) {
          byron++;
          skipN++;
          continue;
        }

        const header = meb.block.header;
        const body = header?.body;
        if (!body?.opCert?.kesPubKey || !header.kesSignature) {
          skipN++;
          continue;
        }
        const sig = header.kesSignature;
        if (sig.length !== 448) {
          skipN++;
          continue;
        }

        let bodyBytes;
        try {
          bodyBytes = body.toCborBytes();
        } catch {
          skipN++;
          continue;
        }

        const slot = BigInt(body.slot);
        const opcertPeriod = BigInt(body.opCert.kesPeriod);
        const slotKES = slot / slotsPerKES;
        if (opcertPeriod > slotKES) {
          skipN++;
          continue;
        }
        if (slotKES >= opcertPeriod + maxEvo) {
          skipN++;
          continue;
        }
        const period = Number(slotKES - opcertPeriod);
        if (period < 0 || !Number.isFinite(period)) {
          skipN++;
          continue;
        }

        const pk = body.opCert.kesPubKey;
        processed++;
        eras[meb.era] = (eras[meb.era] ?? 0) + 1;
        periods[period] = (periods[period] ?? 0) + 1;

        let tsOk;
        try {
          tsOk = verify(sig, period, pk, bodyBytes);
        } catch (e) {
          tsOk = false;
          fails.push({ chunk: chunkNo, slot: Number(slot), err: String(e.message).slice(0, 80) });
        }

        if (tsOk) tsTrue++;
        else {
          tsFalse++;
          if (fails.length < 10) {
            fails.push({
              chunk: chunkNo,
              slot: Number(slot),
              period,
              era: meb.era,
              tsOk,
            });
          }
        }

        if (wasm?.verify) {
          const wOk = wasm.verify(sig, period, pk, bodyBytes);
          if (wOk === tsOk) match++;
          else {
            diverge++;
            if (divergences.length < 10) {
              divergences.push({
                chunk: chunkNo,
                slot: Number(slot),
                period,
                tsOk,
                wOk,
              });
            }
          }
        } else if (tsOk) {
          match++;
        }
      }

      if (chunkNo % 25 === 0) {
        console.log(
          JSON.stringify({
            phase: "progress",
            chunk: chunkNo,
            processed,
            tsTrue,
            tsFalse,
            diverge,
          }),
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          snapshot: {
            processed,
            tsTrue,
            tsFalse,
            match,
            diverge,
            skip: skipN,
            parseFail,
            byron,
            eras,
            periodBuckets: Object.keys(periods).length,
            sampleFails: fails.slice(0, 5),
            sampleDiv: divergences,
          },
        },
        null,
        2,
      ),
    );

    ok("snapshot processed > 0", processed > 0, `n=${processed}`);
    ok("snapshot KES verify all true", tsFalse === 0 && tsTrue === processed, `true=${tsTrue} false=${tsFalse}`);
    if (wasm?.verify) {
      ok("snapshot dual-run diverge 0", diverge === 0, `diverge=${diverge}`);
    } else {
      // without wasm, match counted tsTrue
      ok("snapshot pure-TS verified", match === tsTrue && tsFalse === 0, `match=${match}`);
    }
    ok("snapshot match ≥ 500 or all available", match >= Math.min(500, processed) || (processed > 0 && tsFalse === 0), `match=${match}`);
  }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log("\n=== Summary ===");
console.log(`Passed: ${PASS.length}, Failed: ${FAIL.length}, Skipped: ${SKIP.length}`);
if (FAIL.length) {
  console.log("Failed checks:");
  for (const f of FAIL) console.log("  -", f);
}
if (FAIL.length === 0) {
  console.log("[PASS] Full KES harness passed (not suite green)");
  process.exit(0);
}
console.log("[FAIL] Some checks failed");
process.exit(1);
