# Phase 4 — Pure-TS Mithril crypto research spike

**Status:** research + **Stage 1–5b** (shape → cryptoPrep → merkle → root → preliminary → **BLS aggregate**) + dual-run shadow.  
**Decision:** **do not claim full cert-chain yet.** `rootVerified` / `preliminaryOk` / `aggregateOk` can be true; `verified` / `match` / `implemented` stay false. Hybrid client (WASM certs + pure-TS I/O) is the production path.  
**Date:** 2026-08-05 (density 0–199 green; Stage 1–5b aggregate landed; A2 tvar head scan only).

---

## 1. Goal of this spike

Answer honestly:

1. What crypto surface does Gerolamo already have?
2. What does Mithril cert verify actually require beyond BLS12-381 primitives?
3. What would a KES-style dual-run cutover look like?
4. When (if ever) is a pure-TS port justified?

**Out of scope for this spike:** implementing STM, flipping `pureTsStmImplemented`, claiming pure-TS verify works.

---

## 2. What is already pure-TS (not Phase 4)

| Layer | Status | Tech |
|-------|--------|------|
| HTTP download of immutable / ancillary | ✅ | `fetch` |
| Unpack `.tar.zst` | ✅ | `fzstd` + `tar-stream` |
| Apply chunks → SQLite / MiniBF | ✅ | `processChunk` |
| CLI / bootstrap orchestration | ✅ | `src/mithril/*`, `mithril-bootstrap` |

Phase 4 is **only** replacing **certificate-chain / STM multi-sig verify** currently done by IOG WASM.

---

## 3. What WASM does today (source of truth)

Package: `@mithril-dev/mithril-client-wasm@0.10.8`

| API | Role |
|-----|------|
| `list_cardano_database_v2` | List snapshots |
| `get_cardano_database_v2` | Snapshot detail + locations |
| `verify_certificate_chain(hash)` | **Trust root** — walk certs to genesis vkey |
| `verify_message_match_certificate(message, cert)` | Digest / payload match after unpack |
| `compute_*_message` / proof helpers | Other artifact types (not required for CDB bootstrap) |

Gerolamo wrapper: `src/mithril/client.ts`  
Dual-run hook: `src/mithril/dualRun.ts` → `dualRunCertificateChain(client, hash)`

**WASM remains SoT until dual-run `match === true` on real preprod + mainnet certs.**

---

## 4. On-disk primitive inventory

From `cryptoInventory()` in `src/mithril/dualRun.ts` and package d.ts:

### Present

| Package | Surface |
|---------|---------|
| `@harmoniclabs/crypto` (`bls12_318.d.ts` — filename typo 318) | `BlsG1` / `BlsG2` add, neg, scalarMul, equal, hashToGroup, compress/uncompress; `bls12_381_millerLoop`; `bls12_381_mulMlResult`; `bls12_381_finalVerify` |
| `@noble/curves` (nested) | BLS12-381 pairing, `millerLoopBatch`, `pairingBatch`, signature helpers |
| `@mithril-dev/mithril-client-wasm` | Full client verify (SoT) |

### Stage 1 done (shape only — not crypto)

| Artifact | Role |
|----------|------|
| `src/mithril/pureTs/cert.ts` | hex→JSON AVK + multi_signature; root 32B, sigma 48B, batch_proof |
| `testdata/mithril/certs/preprod/latest-verified-chain.json` | golden vector |
| `dualRunCertificateChain` | WASM SoT + pure-TS `shapeOk` shadow; `match` stays false |
| Smoke | `shapeOk=true`, `verified=false`, `match=false`, `wasmOk=true` |

### Stage 2 done (crypto *prep* only — still not STM verify)

| Artifact | Role |
|----------|------|
| `src/mithril/pureTs/stm.ts` | G1_uncompress(sigma 48B), G2_uncompress(path[0] 96B), millerLoop plumbing |
| `prepareStmCrypto` / `validateStmCryptoPrep` | `cryptoPrepOk`; **`verified=false` always** |
| dualRun shadow | `pureTs.cryptoPrepOk` + `stmPrep`; `match` stays false |
| Smoke | `cryptoPrepOk=true`, `millerLoopResult.c0/c1` present, `implemented=false` |

**Stage 2 is NOT aggregate verify.** It only proves BLS ops work on real cert bytes.

### Stage 3 done (Merkle *structural*)

| Artifact | Role |
|----------|------|
| `src/mithril/pureTs/merkle.ts` | `validateBatchProofStructural` — sizes, indices, depth vs AVK |
| `expectedMerklePathLen` / `validateMerkleStructuralGolden` | heuristics + CI checks |
| dualRun shadow | `pureTs.merkleStructOk` + `merkle` |
| Smoke | golden: nValues=5, nrLeaves=23, indices=[20]; `merkleStructOk=true` |

### Stage 4 done (Merkle *root path crypto* — Blake2b-256)

| Artifact | Role |
|----------|------|
| `verifyBatchProofWithRoot` / `verifyMerkleBatchRoot` | IntersectMBO batch path → AVK root |
| Hash | `Blake2b-256` = `MithrilMembershipDigest::ConcatenationHash` (`Blake2b<U32>`) |
| Leaf | `VK(96B G2) \|\| stake BE u64` (104B) → Blake2b-256 |
| Source | `IntersectMBO/mithril` `mithril-stm/.../commitment.rs` + `leaf.rs` |
| dualRun shadow | `pureTs.rootVerified` + `merkle.rootVerified` |
| Smoke | golden preprod: **`rootVerified=true`**; `verified=false`; `match=false` |

**Stage 4 is NOT full STM.** It only proves the Merkle membership path for concatenation proofs.

### Stage 5a done (STM *preliminary* only — lottery / bounds / k)

| Artifact | Role |
|----------|------|
| `evaluateDenseMapping` | Blake2b512(`"map"` \|\| msgp \|\| index_LE_u64 \|\| sigma) → 64B |
| `isLotteryWon` | `p = ev/2^512 < 1-(1-phi_f)^w` (f64 trivial; golden 12/12) |
| `buildStmMessagePrime` | **msgp = utf8(signed_message hex string) \|\| AVK root** — NOT decoded hex |
| `preliminaryVerifyStm` / `preliminaryVerifyFromParsed` | bounds + lottery + unique indices + k |
| dualRun shadow | `pureTs.preliminaryOk` + `stmPrelim`; `match` stays false |
| Smoke | golden preprod: **`preliminaryOk=true`**, lotteryWins=12; `verified=false` |

**Critical msg binding (IntersectMBO cert verifier):**  
`certificate.signed_message.as_bytes()` = UTF-8 of the hex *string*, then `concatenate_with_message` appends AVK root.

**Stage 5a is NOT aggregate verify.** No MSP.BKey / MSP.BSig; no chain-to-genesis.

### Stage 5b done (BLS multi-sig *aggregate* verify — pairing under msgp)

| Artifact | Role |
|----------|------|
| `blsMinSigVerify` | `e(sig, G2) == e(H_G1(msgp, DST=""), pk)` |
| `BLS_MIN_SIG_DST` | **empty** — blst min_sig default; proven on golden |
| `aggregateBlsSignatures` | n=1 identity; n≥2 Blake2b-128 scalars + weighted G1/G2 sum |
| `verifyStmAggregate` / `verifyStmAggregateFromParsed` | collect (sigma, vk) → aggregate → pairing |
| dualRun shadow | `pureTs.aggregateOk` + `stmAggregate`; `match` stays false |
| Smoke | golden preprod: **`aggregateOk=true`**, mode **`identity`** (n=1) |

**Honest limits:**
- Golden cert has **1** signature → identity path only. Weighted n≥2 is coded but not soaked on real multi-signer certs.
- **Still NOT** chain-to-genesis / message-match / dual-run `match: true`.
- `aggregateOk ≠ verified ≠ match ≠ implemented`.

### A2 scaffold (independent of STM)

| Artifact | Role |
|----------|------|
| `streamTvarHead` / `scanAncillaryTvarHead` | bounded head scan of `tables/tvar` |
| `utxoExtracted` | **always false** — no UTxO insert |

A2 is a CBOR adapter problem, not STM.

### Still missing (crypto — remaining Phase 4 work)

1. Certificate-chain walk rules to **genesis verification key**  
2. Message encoding for `verify_message_match_certificate` (Cardano DB digests)  
3. Genesis vkey handling + epoch transitions in pure-TS  
4. Dual-run **crypto** match vs WASM on preprod **and** mainnet (`match: true`)  
5. Weighted n≥2 aggregate soak on multi-signer real certs  

**Critical distinction:**  
`millerLoop` / `pairing` ≠ full Mithril cert-chain.  
**`shapeOk` ≠ `cryptoPrepOk` ≠ `merkleStructOk` ≠ `rootVerified` ≠ `preliminaryOk` ≠ `aggregateOk` ≠ `verified` ≠ `match`.**

---

## 5. Dual-run cutover plan (KES-style)

Same pattern as pure-TS KES: never flip SoT until dual-run matches.

### Stages

| Stage | Pure-TS | Call path | Gate |
|-------|---------|-----------|------|
| **0 — now** | stub refuses (`implemented: false`) | WASM only | default |
| **1 — shadow** | real verify, results logged only | WASM decides | pure-TS never blocks bootstrap |
| **2 — dual-run assert** | both must agree in CI / soak | fail build if mismatch | N golden certs preprod + mainnet |
| **3 — pure-TS default** | pure-TS primary | WASM optional fallback | product decision |
| **4 — WASM optional** | pure-TS only | drop WASM dep if desired | packaging win proven |

### Code hooks (already exist)

```text
src/mithril/dualRun.ts
  cryptoInventory()                 → primitives vs mithrilGaps[]
  pureTsVerifyCertificateChain(h)   → always refuses today
  dualRunCertificateChain(client,h) → wasm SoT + pureTs side channel (match=false)

export from src/mithril/index.ts
```

### Hard rules

- Do **not** set `pureTsStmImplemented: true` until Stage 2 passes.  
- Do **not** return `ok: true` from the pure-TS stub.  
- Do **not** claim “pure-TS Mithril client” for cert crypto until Stage 3.  
- Bootstrap / density paths stay on WASM verify throughout Stages 0–2.

---

## 6. Suggested golden-vector capture (when implementing)

Minimal set before any SoT flip:

1. **Preprod** latest Cardano DB snapshot cert hash (live aggregator).  
2. **Preprod** one older epoch cert (chain depth > 1).  
3. **Mainnet** latest + one older (network-magic / genesis vkey differ).  
4. For each: store `certificate_hash`, WASM `verify_certificate_chain` JSON output shape, and (later) message bytes used for message-match after unpacking one chunk range.  
5. Negative cases: wrong hash, truncated chain, wrong network genesis vkey → both engines must reject.

Fixture location (proposed, not created yet):

```text
testdata/mithril/certs/preprod/
testdata/mithril/certs/mainnet/
```

---

## 7. Effort / risk (honest)

| Item | Estimate | Risk |
|------|----------|------|
| STM + cert parse + chain rules | multi-week → multi-month | Silent wrong accept is catastrophic |
| Message-match encoding | days–weeks | Spec drift vs IOG |
| Dual-run harness + vectors | days | Must cover both networks |
| Full cutover + drop WASM | only after long soak | Packaging win may not justify cost |

**When justified:** WASM cannot ship (bundle size, runtime, license, offline policy) **and** product requires in-process verify without IOG WASM.

**When not justified:** current state — Bun runs WASM fine; density and bootstrap already work.

---

## 8. Relation to other work

| Track | Relation to Phase 4 |
|-------|---------------------|
| Density / `mithril-bootstrap` apply | **Independent** — keep going on WASM |
| A2 ancillary UTxO | **Independent** — CBOR adapter, not STM |
| TxMonitor encode bug | **Unrelated** — N2C host only |
| KES pure-TS port | **Process template only** (dual-run discipline) |

---

## 9. Acceptance criteria for “Phase 4 done”

All of:

- [ ] `pureTsVerifyCertificateChain` implements real STM + chain rules  
- [ ] `cryptoInventory().pureTsStmImplemented === true` only after that  
- [ ] `dualRunCertificateChain` → `match: true` on full golden set (preprod + mainnet)  
- [ ] CI job fails on dual-run mismatch  
- [ ] Bootstrap can optionally use pure-TS with WASM fallback  
- [ ] Docs updated; no marketing claim before Stage 3  

**Today:** none of the above. Scaffold + this research only.

---

## 10. References (local)

- `src/mithril/dualRun.ts` — inventory + stub + dual-run API  
- `src/mithril/client.ts` — WASM wrapper  
- `docs/mithril-native-client-research.md` — Phase 0–4 overview  
- IOG client role: https://mithril.network/doc/mithril/advanced/mithril-network/client  
- Package: `@mithril-dev/mithril-client-wasm@0.10.8`

---

## 11. Bottom line

| Question | Answer |
|----------|--------|
| Is hybrid working? | **Yes** — use it for density |
| Is pure-TS I/O done? | **Yes** |
| Is pure-TS **crypto** done? | **No** |
| Is this spike a green light to port STM? | **No** — plan only |
| Next product work | density / live / commit — not STM rewrite |
