# Mithril → native Gerolamo client research

Research notes for embedding Mithril **certify + restore** into Gerolamo without
pretending we already reimplement the full protocol in TypeScript.

**Official intro:** https://mithril.network/doc/mithril/intro  
**How it works:** https://mithril.network/doc/mithril/beginner/how-it-works  
**Client role:** https://mithril.network/doc/mithril/advanced/mithril-network/client  
**Bootstrap guide:** https://mithril.network/doc/manual/getting-started/bootstrap-cardano-node  
**Rust lib:** https://docs.rs/mithril-client  
**WASM npm:** https://www.npmjs.com/package/@mithril-dev/mithril-client-wasm  

---

## What Mithril is (blunt)

Stake-based **threshold multi-signature** over messages (snapshots, stake
distributions, tx sets). SPOs **sign**; **aggregators** combine to multi-sig and
publish **certificates** + artifacts; **clients** verify the certificate chain
back to a **genesis verification key**, then download/unpack artifacts and check
the message matches the cert.

Phases (docs): protocol establishment → initialization (keys / AVK per epoch) →
operations (lotteries, individual sigs, aggregate, certify).

**Client does not replace consensus.** It proves “enough stake certified this
artifact,” then a node/indexer ingests files.

Artifacts clients care about:

| Artifact | Use for Gerolamo |
|----------|------------------|
| **Cardano DB snapshot** (immutable + optional ancillary) | Fast bootstrap of chunk files |
| Mithril stake distribution | Light-client / era AVK context |
| Cardano stake distribution | Query / light wallets |
| Cardano transactions + proofs | Tx inclusion proofs (not density) |

---

## What Gerolamo does today

| Piece | Reality |
|-------|---------|
| `src/mithril/*` | Hybrid client: WASM list/verify + pure-TS download/extract |
| `mithril-bootstrap` CLI | `--engine wasm\|bin\|auto` → `runMithrilBootstrap` |
| Cert chain | **IOG** `@mithril-dev/mithril-client-wasm` (`verify_certificate_chain`) — not pure-TS STM |
| Download/extract | HTTP + **fzstd** + **tar-stream** (no system `zstd`/`tar`) |
| `--engine bin` | Optional external `mithril-client` for full multi-GB restore |
| Density after download | `processChunk` / batch hydrate on **immutable** dir |
| `load-ancillary` / `mithril.ts` | **A2 blocked**: indefinite CBOR + `SubCborRef` + OOM on full `tvar`; honest early-exit, no fake UTxO |

Honesty: we do **not** reimplement Mithril STM multi-sigs in TypeScript (Phase 4 only if needed).

---

## Building a client “into” Gerolamo — options

### Option A — Keep binary orchestration (status quo+)

**Pros:** Correct crypto today; IOG maintains STM + chain rules.  
**Cons:** PATH/Docker dependency; weak progress UX unless we parse client logs.

**Work:** Stream `mithril-client` stdout → Lab UI; pin version; `--json` where available; always follow with `batch-hydrate`.

### Option B — Official WASM / JS bindings (recommended native path)

Package: `@mithril-dev/mithril-client-wasm` (Node + web targets).

Docs/examples show:

- `MithrilClient(aggregator, genesis_verification_key)`
- list/get stake distributions, certificates
- `verify_certificate_chain`
- message compute + `verify_message_match_certificate`

Rust `mithril-client` crate (0.14.x) is the full library: Cardano DB v2
list/get/download_unpack, digest verify, merkle proof, certificate chain,
feedback hooks. WASM is a subset oriented at browser verify; **large snapshot
download/fs** may still want CLI or native Rust/`fs` feature.

**Gerolamo integration sketch:**

```text
src/mithril/
  client.ts          # wrap WASM or FFI
  bootstrap.ts       # list → verify chain → download → paths
  types.ts
cli: mithril-bootstrap --engine wasm|bin
```

Still: **immutable chunks → batch-hydrate**. Do not block density on ancillary.

### Option C — Pure TS STM/cert verify

Reimplement Mithril STM + certificate chain in TS.

**Pros:** No Rust/WASM.  
**Cons:** High crypto surface, era upgrades, easy to be subtly wrong; multi-month.

**Only after** Option B proves product need. Prefer **verify via WASM**, TS for I/O + UX.

### Option D — HTTP-only “trust aggregator”

Download snapshot URLs from aggregator JSON **without** cert chain.

**Reject** for anything labeled trustless. OK only as explicit `--insecure` dev mode.

---

## Recommended roadmap

### Phase 0 — Documented hybrid ✅ DONE

- External `mithril-client` path retained as `--engine bin`  
- Gerolamo batch apply for soft state  
- Ancillary: **do not claim** UTxO load (A2)  

### Phase 1 — In-process verify (WASM) ✅ DONE

1. Depend on `@mithril-dev/mithril-client-wasm` 0.10.8 (Node target).  
2. `src/mithril/client.ts`: genesis vkey fetch, aggregator by network, `list_cardano_database_v2`, `verify_certificate_chain`.  
3. CLI: `mithril-bootstrap --engine wasm|bin|auto`.  
4. Smoke: preprod list + cert chain OK (logged).  

**Not pure-TS crypto** — cert verify stays in IOG WASM (correct; see Phase 4).

### Phase 2 — Cardano DB download / range restore ✅ DONE (partial honesty)

| Done | Not done yet |
|------|----------------|
| `get_cardano_database_v2` for locations | Full multi-GB parallel restore UX |
| HTTP download of immutable `{n}.tar.zst` | `download_and_verify_digests` / merkle message match beyond chain verify |
| Pure-TS unpack: **fzstd** + **tar-stream** | Ancillary download/apply (A2 blocked) |
| `--from-chunk` / `--to-chunk` / `--limit-chunks` | Lab progress UI polish |
| Optional `processChunk` apply after download | |

```text
src/mithril/
  types.ts       # snapshot / bootstrap option shapes
  client.ts      # WASM wrapper (list + verify)
  download.ts    # HTTP + fzstd + tar-stream + bin fallback
  bootstrap.ts   # engine orchestration
  index.ts       # public barrel
cli: mithril-bootstrap --engine wasm|bin|auto --limit-chunks N
```

### Phase 3 — Ancillary / ledger state 🟡 PARTIAL (UTxO still A2)

| Done | Not done |
|------|----------|
| `probeAncillaryLedger` — hex sniff (`guessFormatFromHead` / `sniffFileHead`) + LazyCbor top of `state`/`meta` | Full UTxO extract from `tables/tvar` |
| `downloadAncillary` — HTTP + fzstd/tar-stream (~397MB zst / ~1GB unpack) | Streaming CBOR walker for indefinite maps |
| CLI `--include-ancillary` + bootstrap wire + probe after land | Instant UTxO hydrate claim |
| Honest `utxoExtracted: false` always | |

**Still blocked (A2):** nested indefinite CBOR + ~800MB–1GB `tvar` OOM if fully unwrapped.  
Density path remains immutable chunks (`processChunk` / `read-raw-chunks`).  
**A2 is an adapter problem, not an aggregator problem.**

```text
src/state/mithril.ts     # probe + hex sniff + load-ancillary (probe JSON only)
src/mithril/download.ts  # downloadAncillary / findAncillaryLedgerDir
cli: mithril-bootstrap --include-ancillary
cli: load-ancillary <ledgerPath>
```

Ancillary URL (preprod, HEAD 200 ~397MB):  
`…/cardano-database/ancillary/preprod-e305-i6024.ancillary.tar.zst`

### Phase 4 — Optional pure-TS crypto 🟡 SCAFFOLD ONLY

| Done | Not done |
|------|----------|
| WASM `verifyCertificateChain` / message-match wrappers | Pure-TS STM multi-sig |
| `cryptoInventory()` — BLS primitives present vs STM gaps listed | Dual-run `match: true` on real certs |
| `dualRun.ts` — pure-TS always `implemented: false` | Cert chain rules port |
| BLS12-381 in deps (`@harmoniclabs/crypto` millerLoop/finalVerify; `@noble/curves` pairing) | Genesis vkey + message encoding in pure-TS |
| Research spike: dual-run stages + golden-vector plan | Actual STM port |

**WASM remains SoT.** Do not claim pure-TS verify works. Port only if WASM packaging is a product blocker (KES-style dual-run cutover).

**Full spike write-up:** [`docs/phase-4-pure-ts-crypto-research.md`](./phase-4-pure-ts-crypto-research.md)

```text
src/mithril/dualRun.ts
  cryptoInventory()                 → primitives vs mithrilGaps[]
  pureTsVerifyCertificateChain()    → always refuses
  dualRunCertificateChain(client,h) → wasm SoT + stub side channel (match=false)
docs/phase-4-pure-ts-crypto-research.md  → inventory, gaps, dual-run stages 0–4
```

---

## What “done” means for Gerolamo

| Claim | Status |
|-------|--------|
| “Mithril bootstrap built-in” | ✅ Phase 1–2: verify + obtain immutable dir without manual CLI folklore |
| “Trustless snapshot” | 🟡 Cert chain to genesis vkey ✅; full digest/message match still thin |
| “Instant UTxO from Mithril ledger” | ❌ Phase 3 A2 — probe/download only; use chunk soft-apply |
| “Replaces cardano-node” | **Never** Mithril’s job |
| “Pure-TS Mithril crypto” | ❌ Scaffold only; WASM certs by design |

---

## Concrete next engineering steps

1. Lab progress: cert validate → download % → batch-hydrate %.  
2. Optional: compute digests + `verify_message_match_certificate` after unpack.  
3. Phase 3 UTxO: streaming LazyCbor walker for `tvar` (hard; separate spike).  
4. Phase 4 pure-TS STM only if WASM is blocked in product.

---

## References (bookmark)

- Intro: https://mithril.network/doc/mithril/intro  
- Nutshell: https://mithril.network/doc/mithril/beginner/mithril-in-a-nutshell  
- Architecture client: https://mithril.network/doc/mithril/advanced/mithril-network/client  
- Certificate chain design: https://mithril.network/doc/mithril/advanced/mithril-protocol/certificates  
- Network configs: https://mithril.network/doc/manual/getting-started/network-configurations  
- mithril-client crate: https://docs.rs/mithril-client  
- WASM: https://www.npmjs.com/package/@mithril-dev/mithril-client-wasm  
- Upstream monorepo: https://github.com/input-output-hk/mithril  

**Gerolamo local:** `src/cli.ts` (`mithril-bootstrap`), `src/state/mithril.ts` (A2), `docs/hydration.md` (density).
