# vendor/

Tarballs of HarmonicLabs libraries that Gerolamo depends on but that are not
published to npm yet. They are committed so a fresh clone installs with plain
`bun install` and no sibling checkouts.

| Tarball | Source repo |
|---|---|
| `harmoniclabs-kes-*.tgz` | https://github.com/HarmonicLabs/kes-ts (pure-TS KES verify) |
| `harmoniclabs-cardano-ledger-ts-*.tgz` | HarmonicLabs/cardano-ledger-ts (ships `dist/`) |

`package.json` references them as `"file:vendor/<name>.tgz"`.

To refresh after changing a library: bump its version, then run
`scripts/vendor-pack.sh`, update the spec in `package.json` if the filename
changed, and `bun install`. Remove a tarball here once the package is on npm
and the spec points at a registry version.
