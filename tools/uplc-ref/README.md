# uplc-ref — reference Plutus evaluation (aiken's `uplc` crate)

An independent evaluator for checking Gerolamo's Plutus shadow (PLAN_LEDGER_INTEGRITY.md C).
The `uplc` crate reproduces cardano-node's execution units on preview to the unit, and it
builds its own script context, so it separates evaluator bugs from context bugs.

```
cd tools/uplc-ref && cargo build --release
B=tools/uplc-ref/target/release/uplc-ref

# files for a transaction: tx.hex, inputs.hex, outputs.hex (scripts/aiken-simulate.ts writes them)
bun scripts/aiken-simulate.ts --tx <hash> --network preview        # also runs `aiken tx simulate`
$B eval-tx  /tmp/aiken-sim-<hash8> 1666656000000 0 1000 costs.json  # every redeemer, own context
$B ctx      /tmp/aiken-sim-<hash8> 1666656000000 0 1000             # dump aiken's script contexts
$B eval-prog <applied program, cbor-wrapped flat hex> v2 costs.json # a program we dumped
$B eval-text <file.uplc> v3 costs.json                               # textual UPLC

# our side: GEROLAMO_PLUTUS_DUMP_DIR=<dir> bun scripts/shadow-tx.ts … writes <tag>-<idx>.hex
# (applied program) and <tag>-<idx>.ctx.hex (our script context); compare contexts with
bun scripts/data-diff.ts <dir>/0-0.ctx.hex /tmp/aiken-sim-<hash8>/aiken-0-0.ctx.hex
```

`costs.json` is `{"PlutusV1":[…],"PlutusV2":[…],"PlutusV3":[…]}` (Koios `epoch_params.cost_models`).
Slot config: preview `1666656000000 0 1000`, preprod `1655769600000 86400 1000`, mainnet `1596059091000 4492800 1000`.
`aiken tx simulate` itself rejects transactions whose reference inputs carry unused scripts; `eval-tx` does not.

## Vendored `uplc` crate (2026-09-07)

`vendor/uplc` is aiken's `uplc` 1.1.21 with one diagnostic: `UPLC_BUILTIN_TRACE=1` prints every
saturated builtin call (`BUILTIN Name(args) -> result`) to stderr. `Cargo.toml` patches
`crates-io` to it. Our machine has the matching `GEROLAMO_BUILTIN_TRACE=1` (plutus-machine patch);
aligning the two traces finds the first divergent call. `show-prog <hex>` pretty-prints a dumped
program; `eval-text`/`eval-prog` print the result term and the trace logs.
`scripts/builtin-cost-diff.ts <costs.json> v1|v2|v3 [--edge|--edge2]` runs one program per builtin
through both machines and reports budget or result differences.
