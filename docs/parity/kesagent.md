# Parity wave: KES agent (3a) and equivocation detection (3b)

Area `kesagent`, items 450 to 459. Baseline 31ea98f. References: input-output-hk/kes-agent at 44fdcec
(`gerolamo-wt/ref-kes-agent`; the IntersectMBO URL does not exist, the repo lives under input-output-hk),
Dingo at 14f789e (`ref-dingo/kesagent`, `node_equivocation.go`).

Note on Dingo: Dingo's `kesagent` package speaks blinklabs-io/bursa's JSON protocol (`bursa-kes-agent/1`,
length-prefixed JSON frames, `serve-key` / `sign` modes). That is a different protocol from the one
cardano-node 10.7.1+ speaks with input-output-hk/kes-agent. Gerolamo implements the cardano-node one.
From Dingo we ported behaviour: socket path check, reconnect backoff, frame body timeout, key wiping,
the self-sign probe, and its opcert fixture.

## 450 kes-agent service protocol codec

What: `src/pool/kesAgent/protocol.ts`. Raw big-endian binary on a Unix socket, no frames:
version offer (`u32 n` then `n` 32-byte zero-padded names), answer (`0x01 id` or `0x00`), version echo
(32 bytes), then pushes. `Service:2.0`: `u8 kind (0 key, 1 drop) | u64 timestamp µs | bundle`.
`Service:1.0`: bare bundle. Bundle (724 bytes): Sum6 sign key (608) | `u32` period | opcert
(KES vkey 32, `u64` counter, `u64` KES period, cold signature 64). Reply: `RecvResult` as `u32`
(0 OK, 1 KeyOutdated, 2 InvalidOpCert, 3 NoKey, 4 UnsupportedOperation, 0xffff Unknown).
Sources: `Protocols/VersionHandshake/*`, `Protocols/Service/V1,V2/Driver.hs`, `Serialization/DirectCodec.hs`,
`Serialization/RawUtil.hs` (RecvResult is a Word32 on the wire; `protocol.html` still says 2 bytes, which is stale).
The first 612 bytes of a bundle are exactly @harmoniclabs/kes's in-memory key (608 body | u32 BE period).

Tests: `src/pool/kesAgent/protocol.test.ts` (5 tests): golden hex for version ids, offer, answer,
RecvResult codes, key / drop / V1 messages; kes-agent's own fixture certificate (`fixtures/opcert.cert`,
counter 7, period 1430, copied to `src/pool/__fixtures__/kes-agent/` with its vkeys, no secret keys)
decodes, its cold signature verifies and its wire form is byte-exact; Dingo's fixture certificate maps
to the same wire layout.

## 451 kes-agent client

What: `src/pool/kesAgent/client.ts`, Bun Unix socket. Picks `Service:2.0`, else `Service:1.0`, from the
agent's offer (kes-agent's ServiceClient order). Per session, a V2 push not newer than the previous one
is answered KeyOutdated without being installed (as kes-agent's `runServiceClient`). Reconnects forever:
backoff 250 ms doubling to 30 s, reset only by an installed key (Dingo). Handshake bounded by 10 s; once
the first byte of a push arrived, the rest must arrive within 10 s (Dingo's frame body timeout). Every
buffer that held key bytes is zeroed. Socket path checked: absolute, at most 107 bytes (sun_path),
no abstract names.

Tests: `src/pool/kesAgent/client.test.ts` (8 tests) against `fakeAgent.ts`, an in-process agent on a real
Unix socket speaking the wire protocol: connect, first key, rotation, outdated timestamp, drop,
agent restart and reconnect; rejected key code passthrough; V1-only agent; no common version (answers
`0x00`, keeps retrying); unknown push kind and a stalled push body end the session, the client closes
its socket and reconnects; an agent that appears late; path validation; the byte reader. Ran 5 times, no flakes.

## 452 Producer credentials from a kes-agent

What: `producer.kesAgentSocket` in the producer config, instead of `kesSkeyFile` (mutually exclusive).
`opcertFile` is required with `kesSkeyFile`; with `kesAgentSocket` it is tolerated and ignored
(cardano-node's documented invocation keeps `--shelley-operational-certificate` beside
`--shelley-kes-agent-socket`), the certificate used is always the agent's. Checked by `kesSourceOf`
(`src/pool/kesSource.ts`) in the config loader at startup and in the BlockProducer constructor.

The SIGHUP reload and the agent now share one install path (`installCredentials`): cold key, cold
signature, certificate is for this KES key, KES period window, on-chain counter. Agent-only extras:
a certificate older than the installed one is refused (KeyOutdated); the key must sign a probe message
that verifies against the certificate's KES vkey (Dingo's self-sign probe); a key behind the clock is
evolved forward at once (forward security). Results map to RecvResult: OK, KeyOutdated, InvalidOpCert,
Unknown. DropKey forgets the key; leader slots are then recorded as missed with the reason. Until the
first key arrives the producer schedules but does not forge. Swaps wait for a forge in progress.
SIGHUP in agent mode logs that there is nothing to reload.

Metrics: `/metrics` `producer.credentials = { source, installed, lastUpdate, agent: { connected, version,
connects, disconnects, keysReceived, keysAccepted, keysRejected, drops, lastKeyAt, lastResult, lastError,
backoffMs, nextRetryAt } }`; `producer.opcert` / `producer.kes` / `kesEvolution` are null while no key is
installed. Prometheus: `kesAgent.connected`, `kesAgent.keysReceived/Accepted/Rejected`,
`kesAgent.disconnects`, `kesCredentialsInstalled` (with the cardano-node prefix); the KES period gauges are
omitted while no key is installed. `/stats`: "KES source" row (file, or agent connection, key state, counts).

Tests: `src/pool/BlockProducer.kesagent.test.ts` (3 tests): producer connects to the fake agent, misses a
leader slot before the first key, installs the pushed fixture key and forges a block that passes our
header validator, rotates to a new key with counter + 1 (the next block carries counter 1), refuses the
older certificate (KeyOutdated), a foreign cold key, a key / certificate mismatch and a future KES period
(InvalidOpCert), drops the key on DropKey and stops forging, SIGHUP is refused; a key one evolution behind
is evolved on install and an agent-evolved key (period suffix 1) forges; config validation cases. The
existing SIGHUP tests (`BlockProducer.reload.test.ts`) pass unchanged on the shared path.

## 455 Equivocation detection

What: `src/consensus/equivocation.ts`. Every fully validated Shelley+ header (KES, opcert, VRF, leader
rule; deferred-VRF headers once verified) and every block we forge is keyed by (slot, pool id). A second
different hash for the same key is an equivocation: logged with both hashes, sources and opcert counters
(warn; error if it is our own pool), counted, and kept in a list of the newest 32. Bounded to 10 000
(slot, pool) entries: measured 3.8 MB and 6 µs per header.

Decision on chain selection: observation only, no header is treated as invalid. ouroboros-consensus has
no equivocation rule; Praos chain selection already ranks a same-slot, same-issuer pair by the higher
opcert counter (`tieBreak.ts comparePraos`, already ported), which is how a re-keyed operator wins.
Invalidating the second header would let delivery order decide which block this node keeps and could
split it from the network. Dingo also only observes. Unlike Dingo, detection runs on arrival (Dingo only
sees a competitor after a rollback) and uses the same-slot rule only (Dingo also counts same block
number, which an honest pool produces after losing its own fork).

Exposed: `/metrics` `equivocations = { total, self, tracked, recent[] }`; Prometheus `equivocations`,
`equivocationsOwnPool` counters; `/stats` "Equivocations" row in the sync engine card and an own-pool row
in the producer card. The producer registers its pool id so own-key pairs are flagged.

Tests: `src/consensus/equivocation.test.ts` (4 tests): pairing rules (repeats, other pools, third header,
other slots), own-pool flag, memory bound, and two real headers forged for one slot with the fixture
cold key: both pass `runHeaderValidationJob`, the detector pairs them from the job's own facts, and
chain selection prefers the higher counter.

## 456 Forging safety: one block per slot, also across restarts

Found: `lastForgedSlot` was written after the block was adopted (published), with a plain `writeFileSync`.
A crash between the two, a torn write (unparsable file read as "no state"), or an `adopt` that threw after
applying the block (the retry loop then signed a second, different header for the slot) could each lead
to two blocks for one slot. The deadline and tip checks made it unlikely, not impossible.

Fix (`BlockProducer.ts`): the slot is recorded as `signedSlot` in the state file before the first
signature (write-ahead) and no slot at or below max(lastForgedSlot, signedSlot) is forged; if that write
fails the slot is given up. The state file is written atomically (temp file, fsync, rename). An existing
but unreadable state file makes every slot up to the current wall-clock slot count as signed (only future
slots forge). A retry first checks the tip: if the chain already holds a block at the slot it stops, and
if that block is one of our attempts it is recorded as adopted. `forgeAndAdopt` re-checks the guard.

Tests: `src/pool/BlockProducer.safety.test.ts` (5 tests): signedSlot is on disk when adopt is called;
a restart after a crash between signing and recording does not forge the slot again (inside the slot,
tip not showing the block); a truncated state file blocks slots up to now and later slots forge; adopt
throwing after applying leads to exactly one adopt call; an unwritable state file gives the slot up.
Mutation check: with the guard and the tip check disabled, 3 of the 5 fail.
Measured cost: the atomic, fsync'd state write before signing takes 1.5 ms median (p90 1.7 ms, max 4.9 ms,
20 writes of a 20 kB file on the /media/bakon/data disk), added once per forged slot.

## 457 Optional interop with the real kes-agent

`src/pool/kesAgent/interop.test.ts`, skipped unless `KES_AGENT_BIN` and `KES_AGENT_CONTROL_BIN` are set:
starts `kes-agent run`, generates a staged key with `kes-agent-control`, issues a certificate with the
fixture cold key, installs it, and checks the bundle our client receives (vkey matches, probe signs).
Not run: no kes-agent binary on this machine (it needs a Haskell build with libsodium, secp256k1, blst).

## Operator: switching the producer to a kes-agent

1. Install kes-agent (release tarball or `cabal install exe:kes-agent exe:kes-agent-control`) and start it
   on the producer host: `kes-agent run --service-address /run/kes-agent/service.socket
   --control-address /run/kes-agent/control.socket --cold-verification-key cold.vkey
   --genesis-file shelley-genesis.json`.
2. The agent cannot import an existing `kes.skey`: `kes-agent-control -c /run/kes-agent/control.socket
   gen-staged-key --kes-verification-key-file kes.vkey`, then issue a certificate for that vkey on the cold
   host with counter = on-chain counter + 1 (`bun scripts/pool-register.ts rotate-kes` style, or
   `cardano-cli node issue-op-cert`), then `kes-agent-control ... install-key --opcert-file opcert.cert`.
3. In the node config `producer`: remove `kesSkeyFile` (and `opcertFile`, optional), add
   `"kesAgentSocket": "/run/kes-agent/service.socket"`. Restart the node away from leader slots.
4. Check `/metrics` `producer.credentials`: `source "kes-agent"`, `installed true`, `agent.connected true`,
   and the "KES source" row on `/stats`. Later rotations are steps 2 only; no SIGHUP, no restart.

## Open items

- No real kes-agent run: the evolved-key byte layout is the same by specification (Sum KES `sk | seed |
  vk0 | vk1` recursively, as cardano-crypto-class and @harmoniclabs/kes), and the probe refuses any key
  that does not sign for its certificate, but it is not confirmed against a Haskell-evolved key.
- Dingo's bursa JSON protocol (and its `sign` mode, where the key never leaves the agent) is not
  implemented.
