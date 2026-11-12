# Experimental Bun AOT build

Bun's AOT compiler is **canary-only** as of 2026-11-12. Stable Bun 1.4.4 accepts
`--aot` but does not emit AOT machine code, so the build fails the guard in
`scripts/build-aot.sh`.

## Build

```bash
BUN=/path/to/bun-canary/bun bash scripts/build-aot.sh
# or: BUN=/path/to/bun-canary/bun bun run build:aot
```

Output: `dist/gerolamo-aot` (about 101 MB). `package.json` is embedded because
`src/utils/buildInfo.ts` reads it at runtime.

## Local result on 2026-11-12

| Measurement | AOT | JIT |
|---|---:|---:|
| `--help` startup | **1.62 s** | 2.97 s |
| `--help` max RSS | **225 MB** | 365 MB |
| Binary size | **101 MB** | 150 MB |
| Build time | 2.36 s | ~0.2 s |
| `start-gerolamo` 12 s probe | ran and shut down cleanly | ran, but the compiled JIT binary could not resolve `explorerWorker.ts` |

The AOT node probe used a fresh temporary DB and no ledger, so its memory number
is not a production sync benchmark. It reported about **1.35 GB RSS** versus
**347 MB** for the JIT probe; that needs a same-workload benchmark before any
performance claim.

## Warnings

- A runtime regex remains in `src/api/blockfrost/routes/assets.ts`.
- 9 dependency files compile without TypeScript types.
- Bun canary is not a supported production runtime.
- The compiled JIT binary currently fails to resolve `explorerWorker.ts`; AOT
  embedded it successfully.

Do not publish this binary or replace the production JIT image until a full
sync/Plutus/N2N benchmark and a stable Bun AOT release exist.
