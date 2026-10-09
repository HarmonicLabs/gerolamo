# Mithril beyond bootstrap (workstream 4, items 460–479)

Worktree `gerolamo-wt/mithril`, baseline 31ea98f. References: input-output-hk/mithril at ebc7c38
(`gerolamo-wt/ref-mithril`: mithril-stm, mithril-common, mithril-aggregator, mithril-client),
Dingo 14f789e (`ref-dingo/mithril`, `ref-dingo/dmq`) and Dingo PR #4942 (open, "produce, serve and
certify snapshot artifacts"), CIP-0137.

Summary: certificate verification is now a direct port of mithril-common's verifier with the full
STM multi-signature check. Gerolamo produces cardano-database v2 artifacts from its own chunk store;
for preview immutable file 28880 its Merkle root equals the one Mithril certified, and the node
serves the artifacts with the aggregator's routes. Our `mithril-bootstrap` and IOG's
`mithril-client` 0.13.20 both restore from a Gerolamo node, byte-identical. While doing this we
found that `mithril-bootstrap` never compared the downloaded chunks with the certificate (item 462).

## 460 — STM multi-signature verification, exact port

What: `src/mithril/verify/stm.ts` and `lottery.ts` implement mithril-stm `ConcatenationProof::verify`:
msgp = signed_message (UTF-8) || AVK root; for each lottery index, index <= m and the lottery is won
(dense mapping `Blake2b-512("map" || msgp || index_le || sigma)`); indices unique and at least k;
signers' `vk || stake` leaves are members of the AVK Merkle tree (batch path, Blake2b-256, padding
leaf `H(0x00)`); BLS aggregate (Blake2b-128 scalars over all sigmas and the index, weighted sums of
vks and sigmas) verifies with `e(sig, g2) == e(H_G1(msgp), vk)`, empty hash-to-curve DST as blst
min_sig. BLS uses `@noble/curves` 1.9.7 (already a dependency, pure TS).

Why: the old `pureTs/` path checked the same stages but with gaps:
- the lottery was decided in f64 (`w = Number(stake)/Number(total)`, `phi` scaled by 1e18), not with
  Mithril's exact rational Taylor comparison. Near the threshold it can accept a losing ticket or
  reject a winning one;
- sigma and vk were decoded without the subgroup and identity checks blst does
  (`sig_validate(true)`, `key_validate`);
- its own doc said the weighted (n >= 2) aggregate was never soaked on a multi-signer certificate.

Design: `isLotteryWon` follows `num-integer-backend` (the default feature): q = 2^512/(2^512 - ev),
x = -w * ln(1 - phi_f) with ln computed in f64 and converted exactly to a rational
(`Ratio::from_float`), early stop when q is outside phi +- 3 * next term, false after 1000 terms. All
integer arithmetic is BigInt over a common denominator. Wire decoding is the JSON-hex form the
aggregators publish; the canonical re-encoding (used by the certificate hash) equals the published
hex on every fixture.

Tests: `src/mithril/verify/stm.test.ts` (21): preview single-signer and mainnet 56-signer
certificates verify; negative: flipped sigma bit, flipped message bit, flipped AVK root bit,
inflated stake, flipped vk bit, flipped batch-path value, duplicated index, index above m, k not
reached, signer dropped, lower phi_f, swapped sigmas; a G1 point on the curve outside the subgroup and identity points are
rejected at decoding. Lottery: exact `rationalFromFloat`, edge rules
(phi_f = 1, zero stake, zero total, phi_f out of range), 400 random cases against a reference away
from the threshold, Taylor give-up behaviour.

Measured (Bun 1.4.2, nice 10): single-signer preview certificate 12 ms; mainnet certificate with 50
signers 231 ms. For 56 signers and 1 960 indices: dense mappings 27 ms, lottery 10 ms, Merkle path
1 ms, point decoding with subgroup checks 90 ms, Pippenger aggregation 69 ms, pairing 17 ms.

## 461 — Certificate chain verification, port of MithrilCertificateVerifier

What: `src/mithril/verify/certificate.ts` (model, lossless parse, hashes) and `verifier.ts`
(`verifyGenesisCertificate`, `verifyStandardCertificate`, `verifyCertificateChain`). Standard
certificate: not chaining to itself, content hash (`try_compute_hash`, with canonical AVK and
multi-signature re-encoding), signed_message = protocol message hash, STM proof, current_epoch part
= epoch; against the previous certificate: no epoch gap, previous_hash, AVK chaining (same epoch:
same AVK; new epoch: previous `next_aggregate_verification_key`), protocol parameters chaining (same
epoch: equal by U8F24; new epoch: hash = previous `next_protocol_parameters`). Genesis: content hash,
message hash, Ed25519 strict (`verify_strict`: canonical encodings, no small-order key or R) under
the network's genesis key, epoch part. Error codes carry the Rust enum names
(`CertificateHashUnmatch`, `CertificateChainAVKUnmatch`, ...). `httpClient.verifyCertificateChain`
(used by `mithril-bootstrap`) now runs this verifier; the stage-flag result type is gone from the
bootstrap path.

Differences from the old path, each a possible wrong accept or wrong reject:
- unknown protocol message parts were skipped when hashing; they are now rejected (as serde does);
  a non-legacy `hash_scheme` and SNARK fields are rejected too (we are a non-SNARK client);
- a certificate with `hash == previous_hash` was treated as genesis; now genesis is decided by the
  signature kind only and self-chaining is `CertificateChainInfiniteLoop`;
- u64 values were parsed with `JSON.parse`; now integers above 2^53 stay exact (mainnet total
  stake is 4.0e15 today, the limit is 9.0e15);
- phi_f to U8F24 used `Math.round` (ties up); now ties to even like `fixed::from_num`.

Tests: `src/mithril/verify/verifier.test.ts` (20): content and message hashes of seven real
certificates; standard against predecessor for same-epoch (preview, mainnet 56 signers) and
new-epoch (1131 -> 1130 -> genesis 1129) cases; genesis under the preview key and rejected under the
mainnet key; full offline walk hop2 -> hop1 -> genesis; cache stop. Negative: flipped multi-signature
hex digit, flipped signed_message, altered signer stake, altered protocol message with recomputed
hash, re-hashed message without a matching STM signature, epoch mismatch, self-chaining, wrong
predecessor, AVK chaining, parameters chaining, epoch gap, flipped genesis signature, kind mix-ups.
Fixtures: `src/mithril/__fixtures__/certs/{preview,mainnet}` (aggregator JSON as published, genesis
keys).

Measured, live: preview CardanoDatabase certificate b47be50e… (e1444/i28880) walks 317
certificates to genesis d6b8be9f… (epoch 1129): 57 s against IOG's aggregator (network bound), 5.7 s
against a Gerolamo node serving the chain. Mainnet CardanoTransactions certificate fb04694c… (epoch
660) walks 123 certificates to genesis 25acfcfe… (epoch 539), 59.4 signers per certificate on
average, 86 at most: 80 s against IOG's aggregator, 28.7 s of verification alone (certificates
cached locally).

## 462 — Bug: mithril-bootstrap did not check the downloaded chunks against the certificate (fixed)

What: `mithril-bootstrap` verified the certificate chain, then downloaded the immutable archives
from the locations in the (unsigned) snapshot detail and applied or placed them, without comparing
them with the certified digests or Merkle root. Anyone serving the snapshot detail or the archives
(a CDN, a proxy, or now a Gerolamo node) could substitute chunks. mithril-client does this check
(`download_and_verify_digests`, `verify_cardano_database`).

Fix (`src/mithril/cdb/verifyDownload.ts`, `bootstrap.ts`): after the download, fetch the digests list
(cloud archive or aggregator route), keep files numbered <= the certified beacon, build the MKTree
root, require that the chain-verified certificate signed it (its protocol message with
`cardano_database_merkle_root` set to that root hashes to `signed_message`), then hash every
immutable file in the download directory (not only the requested range: the whole directory can
become the block store) and require each to match. Files of the ancillary archive's last trio are
accepted only through the ancillary manifest, whose signature is now checked whenever ancillary
files are present. `downloadImmutableChunk` refuses an archive that carries anything other than its
own trio. A resumed download directory can hold a trio from an older snapshot (the ancillary
archive's then-unfinished last chunk): requested trios that fail are fetched again once, anything
else left over is an error that asks for a fresh `--download-dir`.

Tests (`src/mithril/cdb/cdb.test.ts`): a stale trio in a resumed download dir is fetched again; a
served archive with different chunk bytes fails with
"tampered (00001.chunk)"; an archive carrying another trio's file is refused; a wrong genesis key
fails with `CertificateGenesis`; extra-trio, missing-file and non-verifiable cases of
`verifyImmutableFiles`.

## 463 — cardano-database v2 digests and Merkle root from a chunk store

What: `src/mithril/cdb/digests.ts`: per-file SHA-256 of every `NNNNN.{chunk,primary,secondary}` in
mithril's file order, the MKTree (Merkle mountain range, Blake2s-256, leaves = UTF-8 of the hex
digests) root over files 0..=beacon, the certificate message match, the snapshot id
(`SHA-256(epoch_be || merkle_root_hex)`), and a digest cache keyed by name, size and mtime. The last
immutable number on disk is treated as still being written.

Proof ("certify"), read-only on the stores:
- Gerolamo node 3037 (synced from genesis; its chunk files were written by Gerolamo, link count 1):
  files 0..28880 = 86 643 files, 15 GB, root
  `5985ac8592ba7c9095705a8924b8a4ef1b0e650900690fbfb2697dca720973a0`, exactly what preview
  certificate `b47be50e648b114e1dc0d8680957cd523f92953201b18d9ff270881ff1cec25d` signs for
  e1444/i28880. 0 of 86 643 digests differ from the aggregator's published digests list. Snapshot id
  `23156c7e…` equals the aggregator's. 51 s cold (nice 10), under 1 s from the cache.
- The cardano-node relay's `00100.*`, `28000.*` and `28880.*` match the same digests.

Tests: preview `00100` trio digests equal the certified ones (fixture: the aggregator's own
`00100.tar.zst`); mithril-merkle-tree golden root; digest filtering; snapshot id of the published
preview snapshot.

## 464 — Producing artifacts: archives, digests archive, snapshot record, `mithril-produce`

What: `src/mithril/cdb/produce.ts`, `store.ts`, `tar.ts`, `certify.ts`, CLI `mithril-produce`.
Layout mirrors the aggregator: `cardano-database-download/immutable/NNNNN.tar.zst` (tar with
`immutable/NNNNN.chunk|primary|secondary`, zstd level 9, the aggregator's default), digests archive
`<network>-e<epoch>-i<n>.digests.tar.zst` holding `<stem>.json`, the certificate chain as published,
and a snapshot record written last (completion marker). Archives are deterministic (ustar, mode
0644, owner 0, mtime 0) and the bytes archived are re-hashed against the digests. Sizes follow the
aggregator (`total` = trios 1..=n, trio 0 excluded; average = total / n).
`mithril-produce` picks the newest aggregator snapshot the store has complete, verifies its chain to
genesis, produces, and refuses unless the local root is the certified one. Gerolamo is not a
registered signer, so it cannot certify a new root itself; uncertified snapshots are kept unlisted.
Ancillary archives are not produced: they need IOG's ancillary signing key and a cardano-node ledger
snapshot.

Tests: tar round trip; our archive of preview 00100 has the aggregator's entry names, order and
bytes, and two builds are byte-identical; producing a root the certificate did not sign is refused;
`produceCertifiedSnapshot` against a served store certifies a second copy and rejects it after one
file changes.

Measured: `mithril-produce --immutable-dir <3037>/db/immutable --network preview --archive-from 100
--archive-to 110`: chain 317 certificates, 86 643 digests, root certified, 11 archives, 55 s.

## 465 — Serving artifacts from the node

What: `src/mithril/cdb/server.ts`, mounted in `peerBlockServer.ts` under `/mithril`, off by default.
Routes: `/`, `/artifact/cardano-database`, `/artifact/cardano-database/epoch/{e}`,
`/artifact/cardano-database/digests`, `/artifact/cardano-database/{hash}` (locations point back to
the node), `/certificates`, `/certificate/{hash}` (stored text, unchanged), downloads under
`/cardano-database-download/{immutable,digests}/`, `POST /statistics/*` accepted. Paths are matched
by pattern, no free-form file access. Certificates and archives need no trust in the node: the
client verifies both.

Config: `"mithril": { "serveArtifacts": true, "artifactsDir": "<store>", "publicBaseUrl": "<optional>" }`,
or `GEROLAMO_MITHRIL_ARTIFACTS=<store>` (`=0` turns it off). Tests: resolver cases; route responses,
404 for missing and traversal paths.

## 466 — Bootstrap from a Gerolamo node, end to end

- Offline test (`cdb.test.ts`): trios 0..3 in a scratch dir, a synthetic chain
  (`verify/syntheticChain.ts`: test genesis key, one real STM signer with phi_f 0.65) certifying the
  root of 0..2, produce, serve with `Bun.serve`, `runMithrilBootstrap` -> chunks byte-identical.
- Live, real data: artifacts produced from node 3037's store (above), served by
  `startPeerBlockServer` on port 3201 with `mithril.serveArtifacts`:
  `mithril-bootstrap --network preview --aggregator http://127.0.0.1:3201/mithril --from-chunk 100
  --to-chunk 110 --skip-apply`: chain of 317 certificates verified from the node in 5.7 s, digests
  root signed, 33 files verified, all byte-identical to 3037's and the relay's files.
- IOG `mithril-client` 0.13.20 (release 2630.1-hotfix, run from scratch) against the same server:
  `cardano-db download --start 100 --end 110 latest` -> "Immutable files have been successfully
  verified with Mithril", 33 files byte-identical.

## 467 — DMQ (CIP-0137): research only

CIP-0137 adds three mini-protocols: node-to-node Message Submission (V1 and V2, pull based like
TxSubmission2: request ids blocking or not with ack/req counts, request messages, reply), and
node-to-client Local Message Submission (submit, accept or reject with reason) and Local Message
Notification (blocking or non-blocking pull of received messages). A message is
`[messageId, [body (90..2000 bytes), kesPeriod, expiresAt], kesSignature (448 bytes),
opcert [vkey, counter, kesPeriod, sigma], coldVkey]`; `messageId = Blake2b-256(cbor(payload))`
(golden vector in the CIP). A node checks the id, expiry (bounded TTL), the opcert (cold key signs
the KES key), the KES signature over the payload, and that the pool is in the stake distribution;
the CIP leaves opcert counter monotonicity as a warning. Each DMQ runs on its own network magic
(Mithril: preview 2147483650, preprod 2147483649, mainnet 2912307721), with its own handshake.

Dingo (ref 14f789e) has only phase 1: `dmq/mempool.go`, a de-duplicating, size-bounded, TTL-swept
message pool with per-peer cursors, not wired to any protocol.

For Gerolamo: the building blocks exist (KES and opcert verification from block header validation,
the stake distribution, the mux and miniprotocol framework). A DMQ node would be a separate
listener (own magic and handshake) with the pool, the two N2N protocol state machines and the two
N2C ones. That is weeks of work and only useful once Mithril signers send signatures over DMQ
(today they POST to the aggregator), so it is not started.

## Open items

- The browser node (`browser/src/node/mithrilAnchor.ts`) still uses the legacy `pureTs/` stages
  (f64 lottery). `src/mithril/verify` is portable (no Buffer, no node:crypto) so it can switch;
  browser dependencies are not installed in this worktree, so it was not changed.
- No verified-certificate cache: every bootstrap walks the chain to genesis (preview 317
  certificates, ~1 min from IOG's aggregator). mithril-client keeps one.
- Multi-signatures in the bytes (CBOR) encoding and SNARK certificates are rejected with a clear
  error; aggregators publish JSON hex today.
- No ancillary archive production (needs IOG's ancillary key).
- Producing all archives of a store is a CLI run (about 5 GB of zstd for preview), not a background
  task in the node.
