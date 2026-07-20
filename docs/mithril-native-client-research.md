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
| `mithril-bootstrap` CLI | Spawns external **`mithril-client`** binary; sets aggregator + genesis vkey |
| Download/verify | **Delegated** to that binary — Gerolamo does **not** verify STM multi-sigs itself |
| Density after download | `processChunk` / batch hydrate on **immutable** dir |
| `load-ancillary` / `mithril.ts` | **A2 blocked**: indefinite CBOR + `SubCborRef` + OOM on full `tvar`; honest early-exit, no fake UTxO |

Honesty already in CLI comments: *does NOT reimplement cert verification*.

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

### Phase 0 — Documented hybrid (now)

- External `mithril-client` for Cardano DB restore  
- Gerolamo batch apply for soft state  
- Ancillary: **do not claim** UTxO load (A2)  
- Lab: one-click = install client → bootstrap → batch-hydrate progress  

### Phase 1 — In-process verify (WASM)

1. Depend on `@mithril-dev/mithril-client-wasm` (Node target).  
2. Implement: genesis vkey fetch, aggregator endpoint by network, `verify_certificate_chain` for selected snapshot cert.  
3. Download: either keep CLI for multi-GB `download_unpack`, or use Rust lib via sidecar if WASM lacks full fs pipeline.  
4. Wire feedback events → structured logs / Lab poll.  
5. Tests: preprod fixture cert hash + known snapshot digest (no full mainnet in CI).

### Phase 2 — Cardano DB v2 digests / range restore

Match Rust example flow:

- `cardano_database_v2().get`  
- `certificate().verify_chain`  
- `download_unpack` (+ optional ancillary flag)  
- `download_and_verify_digests` / `verify_cardano_database`  
- `MessageBuilder` + `certificate.match_message`  

Then point `--chunks` at unpacked `immutable`.

### Phase 3 — Ancillary / ledger state (hard)

Separate from “client”:

- Streaming CBOR reader for indefinite maps / `SubCborRef`  
- Or convert snapshot flavors with IOG tools  
- Or **ignore ancillary** forever and only chunk-replay (current winning path)

**A2 is an adapter problem, not an aggregator problem.**

### Phase 4 — Optional pure-TS crypto

Only if WASM packaging is unacceptable; port verify path with dual-run vs WASM like KES cutover.

---

## What “done” means for Gerolamo

| Claim | Requires |
|-------|----------|
| “Mithril bootstrap built-in” | Phase 1–2: verify + obtain immutable dir without manual CLI folklore |
| “Trustless snapshot” | Full cert chain to genesis vkey + message match |
| “Instant UTxO from Mithril ledger” | Phase 3 adapter **or** finished chunk soft-apply |
| “Replaces cardano-node” | **Never** Mithril’s job |

---

## Concrete next engineering steps (when hydrate idle)

1. Spike: `bun` load `@mithril-dev/mithril-client-wasm` Node target; list preprod snapshots; verify one cert chain (no download).  
2. Compare digest list API vs what `mithril-bootstrap` already passes to CLI.  
3. Design Lab progress: cert validate → download % → batch-hydrate %.  
4. Leave ancillary until streaming CBOR exists; keep `mithril.ts` blocker text.

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
