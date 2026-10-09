# Plan: Dingo parity, wave 3 (started 2026-10-08)

Goal: close the gaps between Gerolamo and Dingo (blinklabs-io/dingo at 14f789e, 2026-10-07) found in the
2026-10-08 comparison. Core node function (sync, validation, block production, N2N/N2C, 64/64 LocalStateQuery
parity with cardano-node) is already level on preview; these are the remaining areas.

Six workstreams run in parallel, each in its own worktree under `../gerolamo-wt/<area>`, detached at the
baseline commit `31ea98f` (the live tree incl. uncommitted work). Shared rules: `../gerolamo-wt/COMMON.md`.
Each area logs its numbered items in `docs/parity/<area>.md`; they move into VALIDATION_STATUS.md at merge.

| # | Area | Worktree | Numbers | Done when |
|---|---|---|---|---|
| 1 | Conformance suites | `conformance` | 400–419 | Cardano Blueprint ledger vectors and ouroboros-mock consensus scenarios run in `bun test`; every failure fixed or explained; counts reported |
| 2 | Dijkstra era and Plutus V4 | `dijkstra` | 420–449 | Dijkstra blocks/txs decode and re-encode byte-identically (fixtures from cardano-ledger and Dingo); era wired into HFC, headers, body rules; Plutus V4 language and new builtins evaluate; no change for current eras |
| 3a | KES agent | `kesagent` | 450–459 | The producer can take its KES key from a kes-agent socket (cardano-node's protocol) instead of a file, with rotation; tested against Dingo's protocol fixtures |
| 3b | Equivocation detection | `kesagent` | 450–459 | Two headers from one issuer in one slot are detected, reported in metrics, and the producer never forges twice for a slot (also across restarts) |
| 4 | Mithril beyond bootstrap | `mithril` | 460–479 | Full STM multi-signature certificate verification (not identity only); Gerolamo produces cardano-database v2 artifacts (immutable archives, digests, Merkle root) from its chunk store, the digests match the certified Mithril ones for the same range, and it serves them over HTTP |
| 5a | UTxO RPC | `utxorpc` | 480–499 | utxorpc v1 Query, Submit, Sync and Watch services served by the node; the official TypeScript SDK client works against it |
| 5b | Blockfrost-compatible API | `blockfrost` | 500–529 | The mini-Blockfrost covers Blockfrost's OpenAPI endpoints a wallet / dApp / explorer needs, with responses shape-compatible with blockfrost-backend-ryo; gaps listed |

Merge procedure: one area at a time into the live tree with a private git index (`git apply --3way`), tests
and tsc between merges; the user's index is never touched. Then restart 3036 (canary), 3037, and the producer
away from leader slots. Dijkstra code must stay inert until a Dijkstra era starts on the network.

Out of scope: pluggable storage backends (Postgres/MySQL/S3/GCS), Leios, Midnight, Bark (Dingo-specific choices).
