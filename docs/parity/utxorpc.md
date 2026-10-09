# Parity wave: UTxO RPC (5a)

Area `utxorpc`, items 480 to 490. Baseline 31ea98f. References: Dingo at 14f789e (`ref-dingo/api/utxorpc`),
Dolos (`../dolos/src/serve/grpc/v1alpha`), pallas-utxorpc (`gerolamo-wt/ref-pallas/pallas-utxorpc`, the
mapper Dolos uses), the spec (`gerolamo-wt/ref-utxorpc-spec`, protos).

Spec version: **v1alpha**. The official TypeScript SDK (`@utxorpc/sdk` 0.9.0, 2026-08-27) depends on
`@utxorpc/spec` 0.19.2, whose generated bindings are v1alpha only. Dolos and Dingo serve v1alpha and
v1beta side by side; there are no published TypeScript bindings for v1beta, so Gerolamo serves v1alpha.

Code: `src/api/utxorpc/` (`server.ts` transport and config, `provider.ts` the node seam, `mapper.ts`
CBOR to protobuf, `params.ts` parameters / genesis / era history, `chain.ts` chain reads and the follower,
`predicates.ts`, `common.ts`, `query.ts`, `submit.ts`, `sync.ts` with WatchService), the search indexes
in `src/ledger/utxoIndex.ts`.

## Method coverage

| Service | Method | State | Notes |
|---|---|---|---|
| Query | ReadParams | done | stored parameter record of the tip's epoch; field masks applied |
| Query | ReadUtxos | done | up to 1000 keys; missing keys are left out (Dolos) |
| Query | SearchUtxos | done | exact address, payment part, delegation part, policy, policy + name, and their `all_of` / `any_of` / `not` combinations; pages with `max_items` / `start_token` (default and cap 10 000, Dingo) |
| Query | ReadData | partial | inline datums of live outputs (new index); a datum-hash output's datum from its producing transaction when the explorer knows the block; else the explorer's inline datums |
| Query | ReadTx | partial | transactions of the volatile blocks always; older ones when the explorer projection runs (it locates the block) |
| Query | ReadGenesis | done | Byron, Shelley, Alonzo, Conway genesis; hash = blake2b-256 of the Shelley file (Dolos); CAIP-2 |
| Query | ReadEraSummary | done | HFC history (node's, else the per-network table); times in Unix ms; current era carries the parameters |
| Submit | SubmitTx | done | the HTTP submit path (validating mempool); a rejection is `INVALID_ARGUMENT` with the reasons |
| Submit | EvalTx | done | node's Plutus evaluator, every script with the transaction budget; measured units per redeemer, fee, traces, errors (missing inputs, failing scripts) |
| Submit | WaitForTx | done | `MEMPOOL` when the mempool holds it, `CONFIRMED` when a selected-chain block carries it; ends when all are confirmed |
| Submit | ReadMempool | done | `TxInMempool` with the parsed transaction |
| Submit | WatchMempool | done | current matching transactions, then each new one; predicates with resolved inputs |
| Sync | FetchBlock | done | by hash, slot, or height (newest 5000 blocks: no height index) |
| Sync | DumpHistory | done | from a start token or origin, up to 100 blocks a page, `next_token` |
| Sync | FollowTip | done | `reset` to the intersection, then `apply`, and `undo` with the rolled-back block's content |
| Sync | ReadTip | done | |
| Watch | WatchTx | done | `apply` / `undo` per matching transaction, `idle` for an applied block without a match; the block travels as its header |

Not served: v1beta (no TypeScript bindings), gRPC health and reflection (Dingo serves both), TLS
(bind to 127.0.0.1 or put a proxy in front), CORS headers for browser gRPC-Web.

## 480 Transport: gRPC h2c, gRPC-Web and Connect on one port

What: `server.ts`. @connectrpc/connect-node 1.4 (`connectNodeAdapter`) behind Bun's `node:http2`
server. A spike on Bun 1.4.2 first: unary calls, server streams, error statuses in trailers (unary
trailers-only responses and stream-ending errors), client cancellation (`RST_STREAM CANCEL` aborts the
handler's signal) all work with the SDK's gRPC transport. One TCP port: a `net` server reads the first
bytes; the HTTP/2 preface goes to the h2 server (`emit("connection")`), anything else is piped to a
`node:http` server on a loopback port. Bun quirk found on the way: a socket handed to Bun's HTTP/1.1
server with `emit("connection")` answers unary calls but aborts server streams after the first message
(`IncomingMessage` "close" fires when the body is read, which connect-node takes for a disconnect);
a real listening socket does not, hence the pipe. `http2.createServer({ allowHTTP1 })` does not work in
plain text on Bun (nor on Node).

Config: `utxorpc: { enabled: true, host, port }` in the node config, default off, host 127.0.0.1,
port 50051; env `GEROLAMO_UTXORPC=host:port | port | 1 | 0` overrides. Started after the HTTP server,
stopped first at shutdown. Request messages are bounded at 1 MiB (Dingo).

Tests: `utxorpc.test.ts` "gRPC-Web and Connect over HTTP/1.1 on the same port" (readTip, a FollowTip
stream and readUtxos over both, plus a plain `fetch` with JSON); every other test uses the SDK's gRPC
transport. Test note: Bun's `expect(promise).rejects` hung on a ConnectError rejection inside this file
(a plain `await` in try / catch does not), so the tests use an `errorOf` helper.

## 481 Cardano CBOR to v1alpha messages

What: `mapper.ts`, written over the evaluator's offset-keeping CBOR reader, following pallas-utxorpc
field by field: inputs, withdrawals and mint in ledger (sorted) order so a redeemer's index points at
its item; `Redeemer.purpose` = tag + 1; `original_cbor` of a redeemer is `[tag, index, data, ex_units]`
(also for Conway map-form redeemers); `Constr.tag` is the CBOR tag (121–127, 1280–1400, 102 with
`any_constructor`); amounts are `BigInt.int` while they fit int64, else `big_u_int` / `big_n_int`
bytes (also Plutus bignums); datum-hash outputs get their payload from the witness datums; scripts
from witnesses (native, V1, V2, V3; pallas leaves V3 out) and auxiliary data (Shelley, Allegra and
Alonzo+ forms); certificates 0–18 incl. Conway; governance proposals with every action (parameter
change as a sparse `PParams`). Byron main blocks map to their transactions' inputs and outputs (the
Byron address is its CBOR); EBBs have none. A transaction's `native_bytes` is the standalone
`[body, witnesses, is_valid, aux]` form rebuilt from the block's slices (byte-identical to what was
submitted). Spent inputs' `as_output` are resolved from the ledger state before the block (the
ledger store's view of the parent while it is volatile), else the current UTxO set.

Tests: `mapper.test.ts` (9): all 27 real preview / preprod block fixtures (Allegra, Babbage, Conway; 128
transactions) against cardano-ledger-ts: transaction count, ids, input / output / certificate /
withdrawal / reference input / collateral / proposal counts, fee, output lovelace, validity flag,
sorted inputs, and the standalone bytes hash to the same id; the 6/19 UpdateCommittee proposal;
a Plutus V2 transaction's redeemer and id; the first mainnet Byron transaction (id as ledger-ts
computes it) and the preprod EBB; BigInt and Plutus data edge cases; parameters from a stored preview
record; the preview genesis.

## 482 UTxO search indexes (store migration)

What: the ledger store had `utxo_addr` (exact address) only. New LMDB database `utxo_idx`, one kind
byte per index, empty values:
`0x01 ‖ payment hash ‖ txid ‖ ix`, `0x02 ‖ delegation hash ‖ txid ‖ ix` (base addresses),
`0x03 ‖ policy ‖ len ‖ name ‖ txid ‖ ix` (each asset held), `0x04 ‖ datum hash ‖ txid ‖ ix`
(datum-hash outputs, and inline datums by the hash of their bytes). `UtxoWrites.put` / `del` keep them
inside the block's diff, so a rollback undoes them like every other write. Lookups always read the
output back from `utxo`, so a key whose output is gone reads as nothing.

Migration: `backfillUtxoIndex` runs once when the node opens its ledger store (marker `0x00 "v1"` in
`utxo_idx`): it scans the LMDB `utxo` database in batches of 20 000 and writes the keys straight into
LMDB, plus the keys of outputs created by the volatile blocks above the anchor (diffs written by the
previous build). Measured on a copy of the 3036 store (`ledger-3036-copy`, read-only dry run):
3 207 237 outputs give 6 911 539 index keys (454 MB of key bytes); the scan and key derivation took
43.9 s, so expect about 1.5 to 2 minutes and roughly 0.7 to 1 GB more `data.mdb` on the first start.
Per block: 25 µs per created output with a base address and one asset against 13 µs before
(`src/ledger/utxoIndex.test.ts` measures 40 µs per output including JSON building). Safety valve:
`GEROLAMO_UTXO_INDEX=0` stops the writes and clears the marker, so a later start without it rebuilds
what is missing (keys of outputs spent meanwhile stay behind as dead keys). A fresh Mithril LMDB
import writes every row through `UtxoWrites` and sets the marker, so no scan follows it.
`store-compare` reports `utxo_idx` as informational (derived from `utxo`, which it compares; dead
keys and stores from before the index are not ledger differences).

Tests: `src/ledger/utxoIndex.test.ts` (4): address parts; keys follow puts, spends, a rolled-back fork
and promotion; a store "written by the old build" (index cleared, a volatile diff without index writes)
is backfilled to the same answers, once; the opt-out and the rebuild after it; the import marker; the cost.

## 483 QueryService

What: `query.ts`. SearchUtxos takes candidates from the indexes of every indexable part of the
predicate (intersection for `match` fields and `all_of`, union for `any_of` when every branch is
indexable), sorts them by output key, checks the whole predicate on each output, and pages by output
key (`start_token` = 34-byte key in hex). A predicate with nothing indexable is `INVALID_ARGUMENT`
("criteria too broad", Dolos); more than 100 000 candidates is `RESOURCE_EXHAUSTED` (the services run
on the node's main thread, beside block application: a search must stay short). Payment and
delegation parts must be 28-byte hashes, an asset name needs a policy (Dingo's checks). `ledger_tip`
is the selected tip with height and time. `native_bytes` of a UTxO is the output rebuilt in Babbage
map form: the store keeps the output's fields, not its bytes (the LocalStateQuery UTxO answers do the
same), so a legacy array-form output's bytes differ from the chain's; `block_ref` is not filled (no
transaction-to-block index without the explorer).

Tests: `utxorpc.test.ts` "ReadUtxos and SearchUtxos …" and "ReadData, ReadTx, ReadParams, ReadGenesis,
ReadEraSummary" (field mask included).

## 484 SyncService and the chain follower

What: `chain.ts`, `sync.ts`. The follower works on the block store's selected chain: it yields a
`reset` to the intersection, then applies the blocks after the client's position; when that position
leaves the selected chain it undoes blocks (read from the volatile set, which keeps fork blocks until
garbage collection) back to the selected chain, or resets to the newest selected block below it when the
block is gone. It wakes on every chain change (a new multi-subscriber `subscribeChainChanged` in
`liveEvents.ts`, emitted by the orchestrator on adoption and rollback) and polls once a second.
FollowTip without intersect points starts at the tip; points not on the chain are `NOT_FOUND`.

Tests: `utxorpc.test.ts` "FollowTip and WatchTx stream the chain as it is applied, rolled back and
switched": the real orchestrator applies P ─ C ─ L, rolls back to C on the primary's RollBackward,
then applies W (the slot battle winner) and X; the SDK stream reads exactly
`reset P, apply C, apply L, undo L, apply W, apply X`, with C's native bytes equal to the store's,
height, slot, timestamp, the transaction with its resolved input, metadata and witness.
"ReadTip, FetchBlock, DumpHistory": the dead fork's block is not found; history pages and tokens.

## 485 WatchService

What: `sync.ts` `watchService`. Each applied / undone block's transactions are mapped (inputs
resolved only when the predicate looks at them) and matched (Dolos' semantics: `has_address` and
`moves_asset` look at outputs and resolved inputs, `consumes` at resolved inputs, `produces` at
outputs, `mints_asset`, `has_certificate` with the any-credential / pool / DRep forms). Dolos sends the
whole block with every matching transaction; Gerolamo sends the block's header (the SDK requires the
block to be there), not its bytes and body.

Tests: the stream test above: the unfiltered watch reads
`apply T0, apply T1, apply T2, undo T1, undo T2, apply T1, apply T2, apply T3`, the payment-part watch
the six applies.

## 486 SubmitService

What: `submit.ts`. SubmitTx goes through the same function as the HTTP submit endpoint (validating
mempool when it runs, else the shared mempool); the reference is the transaction id. WaitForTx
reports `CONFIRMED` at once for a transaction with an unspent output or in a volatile block, else
`MEMPOOL` when the mempool holds it and `CONFIRMED` when a block carrying it is applied; the stream
ends when every reference is confirmed (Dingo). `ACKNOWLEDGED` and `NETWORK` are not reported.
WatchMempool streams additions only (no removal events). The mempool is read through
`ValidatingMempool.snapshot()` / `waitForChange()` (the LocalTxMonitor seam), or the shared-memory
store polled every 500 ms when the validating mempool is off.

Tests: "SubmitTx, ReadMempool, WatchMempool, WaitForTx (mempool, then confirmed by a block)" (a test
mempool behind the provider; the confirming block goes through the real orchestrator).

## 487 EvalTx with the node's Plutus evaluator

What: `evalTx` in `submit.ts`. Resolves inputs, collateral and reference inputs from the ledger store,
takes the parameters of the next slot's epoch, and runs `evaluatePhase2Sync` with a new `budget`
option (`Phase2Input.budget`, default unchanged: the declared units) set to the transaction maximum,
so a builder's placeholder units (zero) do not cap the run. Reports each redeemer's measured units
and payload, their sum, the fee with those units (size, prices, tiered reference-script fee), script
traces and errors. No phase-1 rules are checked (that is SubmitTx's mempool).

Tests: `evalTx.test.ts` (2) on the replayed preview transaction 124008114: redeemer 0:0 measures
468 052 646 steps / 1 534 186 memory (aiken's numbers), purpose SPEND; the fee is above the size part
and at most what the transaction paid; with the declared units rewritten to zero the measurement is
the same. Missing inputs are reported (integration test).

## 488 Field masks

What: `applyMask` in `common.ts`: paths relative to the response (snake_case or camelCase), through
oneofs (`values.cardano.max_tx_size`), on the Query responses. Streams ignore masks.

Tests: ReadParams with a mask in the integration test.

## 489 Smoke and host scripts

What: `scripts/utxorpc-smoke.ts --uri … [--address …] [--follow n] [--wait s] [--submit tx.hex]` calls
every read method with the SDK (and one Connect call) against a running server. `scripts/utxorpc-host.ts
--config <node config> --port 32xx` serves UTxO RPC from a running node's stores opened read-only (like
`lsq-host.ts`), stores attached once, submission refused.

Measured 2026-10-08 against the 3035 node through the host on port 3250: ReadTip, ReadParams (protocol
11, three cost models), ReadGenesis (`cardano:preview`, 363498d1…, the known preview Shelley genesis
hash), ReadEraSummary (`babbage@3, conway@646`), FetchBlock / DumpHistory of the tip, FollowTip,
SearchUtxos by address (22 outputs, 41 ms; a script address with 25 outputs, 64 ms), ReadUtxos,
ReadMempool, Connect ReadTip all answered. Payment-part search answered empty and ReadData found
nothing there: the live store has no `utxo_idx` until the node runs this build. WatchTx timed out
because the host's stores do not move.

## 490 Node wiring

What: `src/network/index.ts` starts the server when configured, with `nodeProvider` (block store,
LMDB ledger store reads, governance-store parameters, genesis files next to the Shelley genesis,
`createHttpPeerManager().submitTx`), and stops it at shutdown. `GerolamoConfig.utxorpc` documents
the key. `eraHistory.ts` exposes the era summary list behind `interpreterFor` (`eraSummaryFor`).

## Open items

- v1beta, gRPC health and reflection, TLS, CORS (see the top).
- ReadTx / ReadData beyond the volatile window need the explorer projection; `AnyUtxoData.block_ref`
  is empty.
- UTxO `native_bytes` are rebuilt, not the chain's bytes (store layout).
- WaitForTx stages `ACKNOWLEDGED` / `NETWORK`; WatchMempool removal events.
- FetchBlock by height reaches only the newest 5000 blocks.
- A client that breaks out of a stream without cancelling it leaves the server stream open until the
  connection closes (observed with the SDK's HTTP/2 transport: `break` does not always send
  `RST_STREAM`).
