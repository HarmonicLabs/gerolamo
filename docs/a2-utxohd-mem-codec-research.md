# A2 utxohd-mem codec research (tablesCodecVersion = 1)

**Status (2026-08):** research + decode scaffold **extended** (CompactAddr + MultiAsset rep).  
**`utxoExtracted` stays `false`** — no DB UTxO inserts; datum/script body still blocked.

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
| Write/read tables CBOR map | `…/LedgerDB/V2/InMemory.hs` |
| `TxIn` MemPack | `cardano-ledger` `Cardano/Ledger/TxIn.hs` |
| `BabbageTxOut` MemPack tags 0–5 | `…/Babbage/TxOut.hs` |
| `CompactForm Coin` | `…/Coin.hs` — `packTagM 0 >> VarLen` |
| `CompactValue` (Mary) | `…/Mary/Value.hs` — **no** nested Coin tag on ada |
| `CompactAddr` / `serialiseAddr` | `…/Address.hs` — header + raw 28B hashes |
| MultiAsset compact `rep` | `…/Mary/Value.hs` `from` / diagram A–E |
| MemPack primitives | `lehins/mempack` `Data/MemPack.hs` |

### MemPack wire rules (verified)

| Primitive | Encoding |
|-----------|----------|
| `Tag` / `packTagM` | **1× Word8** |
| `VarLen` / `Length` | **MSB-first 7-bit groups** (NOT LEB128). High chunk first; cont bit `0x80`. Ex: `45→2d`, `208→8150` |
| `ShortByteString` | `Length` ‖ raw bytes |
| `Word16` / `Word64` in MA rep | **host endian** (LE on x86) |

> **Pitfall (2026-08):** LEB128 (LSB-first) misreads large MA `Length` as huge values (`0x8150` → 10241 instead of 208) → `sbs truncated`. Fix is MSB-first `readVarLenU`.

---

## CompactAddr (`serialiseAddr`)

Header bits (Shelley):

| Bit | Meaning |
|-----|---------|
| 0 | network (1 = mainnet) |
| 4 | payment is script |
| 5 | stake is script (base) **or** enterprise when bit6 set |
| 6 | not base (pointer or enterprise) |
| 7 | Byron when set (`0x82`) |

| Kind | Layout | Len |
|------|--------|-----|
| base | header ‖ pay28 ‖ stake28 | **57** |
| enterprise | header ‖ pay28 | **29** |
| pointer | header ‖ pay28 ‖ varlen slot/txIx/certIx | variable |
| byron | Byron CBOR blob | variable |

**No** MemPack credential tags inside CompactAddr — hashes are raw 28 bytes.

Live spike (tag0/4/5, n≈4356): base **1496** · enterprise **2859** · byron **1** · fail **1**.

---

## MultiAsset compact `rep` (Mary)

```text
tag1 CompactValueMultiAsset:
  packTagM 1 >> VarLen lovelace >> VarLen numMA >> ShortByteString rep
```

`rep` layout (offsets relative to **start of rep**):

```text
A) n × Word64 quantities          (LE)
B) n × Word16 policyId offsets    (LE)
C) n × Word16 assetName offsets   (LE)
D) policyId blob (28B each, unique)
E) asset names blob (sorted unique) + padding
```

Asset name length = next greater name offset − this offset (or `rep.length − offset`).  
Empty names point at end of E.

Live spike: MA header+rep parse **ok** on samples (`NIGHT` / policy `387c0fb5…`).

---

## TxOut MemPack variants (Babbage)

```text
tag0 TxOutCompact'        → CompactAddr ‖ CompactValue
tag1 TxOutCompactDH'      → CompactAddr ‖ CompactValue ‖ DataHash?
tag2 AddrHash28_AdaOnly   → Credential ‖ Addr28Extra(32) ‖ CompactForm Coin
tag3 AddrHash28_AdaOnly_DH32 → Cred ‖ Addr28 ‖ Coin ‖ DataHash32(32)
tag4 TxOutCompactDatum    → CompactAddr ‖ CompactValue ‖ Datum…
tag5 TxOutCompactRefScript→ CompactAddr ‖ CompactValue ‖ Datum ‖ Script…
```

### CompactValue

```text
tag0 AdaOnly     → VarLen lovelace
tag1 MultiAsset  → VarLen lovelace ‖ VarLen numMA ‖ SBS(rep)
```

---

## Code

| Path | Role |
|------|------|
| `src/state/utxohdMemCodec.ts` | MemPack + CompactAddr + MA rep + TxIn/TxOut + head scanner |
| `src/state/mithril.ts` | probe/stream only; **no** UTxO insert |
| `src/state/index.ts` | re-exports |

---

## Honesty / blockers

| Done | Not done |
|------|----------|
| Research + tag map | Datum / RefScript MemPack |
| TxIn 34B keys | CompactAddr → bech32 |
| tag2 full structural | Full 940MB stream→DB |
| CompactAddr base/enterprise/pointer | `utxoExtracted: true` |
| MultiAsset triples (policy/name/qty) | Checksum verify on full tables |
| `utxoExtracted: false` forced | |

**Density (immutable chunks) ≠ UTxO extract.** Do not fake UTxO row counts.

---

## Next (when resuming A2)

1. Datum + script MemPack  
2. bech32 address encode (optional)  
3. Streaming full `tables` → Gerolamo `utxo` with checksum  
4. Only then flip `utxoExtracted`  
