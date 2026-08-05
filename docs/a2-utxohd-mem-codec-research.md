# A2 utxohd-mem codec research (tablesCodecVersion = 1)

**Status (2026-08):** research + decode **scaffold** done.  
**`utxoExtracted` stays `false`** — no DB UTxO inserts, no full MultiAsset/datum/script decode.

---

## Proven on-disk layout (preprod e305)

```text
snapshots/mithril/ledger/130203664/
  meta    JSON  {"backend":"utxohd-mem","checksum":…,"tablesCodecVersion":1}
  state   CBOR  ExtLedgerState EmptyMK  (~29MB)
  tables  CBOR  [1] + indefinite map   (~940MB)
```

`tables` is a **file**, not `tables/tvar`. (Older UTxO-HD docs mentioned `tables/tvar`; Mithril ancillary uses the single-file InMemory snapshot form.)

### CBOR envelope (InMemory.hs)

```text
encodeListLen 1 <> encodeMapLenIndef
  <key0> <val0> <key1> <val1> … encodeBreak
```

Each key/value is a **CBOR bstr** whose payload is **MemPack**, not nested CBOR TxOut.

| Field | Payload |
|-------|---------|
| key   | MemPack `TxIn` → **34 bytes**: `TxId` (32) ‖ `TxIx` (Word16 **BE** in file) |
| value | MemPack `TxOut` (Babbage-compatible tags 0–5) |

---

## Source map (IntersectMBO + lehins)

| Artifact | Where |
|----------|--------|
| Snapshot meta / `utxohd-mem` / `TablesCodecVersion1` | `ouroboros-consensus` `Storage/LedgerDB/Snapshots.hs` |
| Write/read tables CBOR map | `…/LedgerDB/V2/InMemory.hs` (`valuesMKEncoder` / `valuesMKDecoder`) |
| Streaming yield/sink | `…/Cardano/StreamingLedgerTables.hs` — `encodeMemPack` / `decodeMemPack` |
| UTxO-HD overview | `docs/…/utxo-hd/utxo-hd_in_depth.md` |
| `TxIn` MemPack | `cardano-ledger` `Cardano/Ledger/TxIn.hs` |
| `BabbageTxOut` MemPack tags 0–5 | `…/Babbage/TxOut.hs` |
| `AlonzoTxOut` tags 0–3 + `Addr28Extra` | `…/Alonzo/TxOut.hs` |
| `CompactForm Coin` | `…/Coin.hs` — `packTagM 0 >> VarLen` |
| `CompactValue` (Mary) | `…/Mary/Value.hs` — **no** nested Coin tag on ada |
| `Credential` | `…/Credential.hs` — tag0 script / tag1 key + 28B hash |
| `CompactAddr` | `…/Address.hs` — newtype SBS (`serialiseAddr`) |
| MemPack primitives | `lehins/mempack` `Data/MemPack.hs` |

### MemPack wire rules (verified)

| Primitive | Encoding |
|-----------|----------|
| `Tag` / `packTagM` | **1× Word8** (`packedTagByteCount = 1`) |
| `VarLen Word64` | **LEB128** (7-bit groups, high bit continue) |
| `Length` (SBS) | `VarLen` of byte length |
| `ShortByteString` | `Length` ‖ raw bytes |
| `Word64` (Addr28 words) | **8-byte native** (host endian in GHC; treat as opaque 32B block) |

---

## TxOut MemPack variants (Babbage)

```text
tag0 TxOutCompact'        → CompactAddr ‖ CompactValue
tag1 TxOutCompactDH'      → CompactAddr ‖ CompactValue ‖ DataHash
tag2 AddrHash28_AdaOnly   → Credential ‖ Addr28Extra(32) ‖ CompactForm Coin
tag3 AddrHash28_AdaOnly_DH32 → Cred ‖ Addr28 ‖ Coin ‖ DataHash32(32)
tag4 TxOutCompactDatum    → CompactAddr ‖ CompactValue ‖ Datum
tag5 TxOutCompactRefScript→ CompactAddr ‖ CompactValue ‖ Datum ‖ Script
```

### CompactValue (Mary) — important

```text
tag0 AdaOnly     → VarLen lovelace          (NOT CompactForm Coin’s extra tag)
tag1 MultiAsset  → VarLen lovelace ‖ VarLen numMA ‖ rep…
```

`CompactForm Coin` (used by tag2/3) **does** use `packTagM 0 >> VarLen`.

---

## Live spike (preprod tables head, n=4811)

| Tag | Count | Scaffold result |
|-----|------:|-----------------|
| 0 | 2755 | Ada-only fully consumed **1668**; MA partial **1087**; fail **0** |
| 1 | 102 | prefix only |
| 2 | 1098 | **1098/1098 fully consumed** (lovelace + cred + addr28) |
| 3 | 2 | rare |
| 4 | 778 | addr+value ok; datum body blocked |
| 5 | 76 | addr+value ok; datum+script blocked |

Sample tag2: `cred=key`, `lovelace=48284929`, `payHash=f72d0e90…`.  
Sample tag0 ada: `addrLen=29`, `addr0=0x60`, `lovelace=245029510`, fully consumed.

---

## Code

| Path | Role |
|------|------|
| `src/state/utxohdMemCodec.ts` | MemPack primitives + TxIn/TxOut scaffold + head entry decoder |
| `src/state/mithril.ts` | probe/stream only; **no** UTxO insert |
| `src/state/index.ts` | re-exports scaffold |

---

## Honesty / blockers

| Done | Not done |
|------|----------|
| Research + tag map | MultiAsset `rep` body |
| TxIn 34B keys | Datum / RefScript MemPack |
| tag2 full structural decode | CompactAddr → bech32/hex address |
| tag0 ada lovelace | Full 940MB stream→DB |
| `utxoExtracted: false` forced | `utxoExtracted: true` |

**Density (immutable chunks) ≠ UTxO extract.** Do not fake UTxO row counts.

---

## Next (when resuming A2)

1. CompactAddr (`serialiseAddr`) → payment/stake credentials  
2. MultiAsset map body  
3. Datum + script MemPack  
4. Streaming full `tables` → Gerolamo `utxo` with checksum verify  
5. Only then flip `utxoExtracted`  
