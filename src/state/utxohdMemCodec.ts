/**
 * A2 utxohd-mem tablesCodecVersion=1 — pure-TS MemPack decode scaffold.
 *
 * Proven layout (preprod e305, IntersectMBO sources 2026-08):
 *   tables = CBOR [1] + indefinite map of (TxIn bytes → TxOut MemPack bytes)
 *   TxIn   = MemPack: TxId(32) || TxIx(Word16 BE)  → 34-byte key
 *   TxOut  = MemPack Babbage tags 0–5 (Alonzo 0–3 subset)
 *
 * Honesty:
 *   - tag2 AdaOnly fully decoded (lovelace + stake cred + addr28)
 *   - tag0 Compact: CompactAddr (base/enterprise) + AdaOnly fully;
 *     MultiAsset lovelace + asset triples (policy/name/qty) when rep parses
 *   - tag1/3: dataHash when present; tag3 Addr28+hash fully when lengths match
 *   - tag4: CompactAddr + CompactValue + BinaryData (SBS) — envelope fullyConsumed
 *   - tag5: + Datum (0/1/2) + AlonzoScript (native SBS / plutus lang+SBS) — envelope only
 *   - Plutus body is opaque bytes (no interpreter); DB path may store hex/len metadata
 *
 * Sources: docs/a2-utxohd-mem-codec-research.md
 *   - lehins/mempack Tag=Word8, Length=VarLen MSB-first, VarLen Word64
 *   - cardano-ledger Babbage/Alonzo TxOut + Plutus Data.hs + Alonzo Scripts MemPack
 *   - ouroboros-consensus InMemory.hs tables CBOR map
 */

export type DecodeError = { ok: false; error: string; off: number };
export type DecodeOk<T> = { ok: true; value: T; next: number };
export type DecodeResult<T> = DecodeOk<T> | DecodeError;

export type TxInDecoded = {
    txIdHex: string;
    txIx: number;
};

export type CredentialKind = "script" | "key";
export type NetworkId = "mainnet" | "testnet";

/** CompactAddr = serialiseAddr bytes (header + raw 28B hashes, no MemPack cred tags). */
export type CompactAddrDecoded =
    | {
          kind: "base";
          network: NetworkId;
          payScript: boolean;
          stakeScript: boolean;
          payHashHex: string;
          stakeHashHex: string;
      }
    | {
          kind: "enterprise";
          network: NetworkId;
          payScript: boolean;
          payHashHex: string;
      }
    | {
          kind: "pointer";
          network: NetworkId;
          payScript: boolean;
          payHashHex: string;
          slot: bigint;
          txIx: bigint;
          certIx: bigint;
      }
    | {
          kind: "byron";
          header: number;
          rawLen: number;
      };

export type MultiAssetTriple = {
    policyIdHex: string;
    assetNameHex: string;
    quantity: bigint;
};

export type MultiAssetRepDecoded = {
    numAssets: number;
    assets: MultiAssetTriple[];
};

export type CompactValueDecoded =
    | { kind: "ada"; lovelace: bigint }
    | {
          kind: "multiAsset";
          lovelace: bigint;
          numAssets: number;
          assets: MultiAssetTriple[];
          /** true when MA header + rep SBS fully consumed in the value blob */
          repFullyDecoded: boolean;
      };

export type TxOutDecoded =
    | {
          tag: 0;
          variant: "TxOutCompact";
          addrRaw: Uint8Array;
          addr: CompactAddrDecoded | null;
          value: CompactValueDecoded;
          fullyConsumed: boolean;
      }
    | {
          tag: 1;
          variant: "TxOutCompactDH";
          addrRaw: Uint8Array;
          addr: CompactAddrDecoded | null;
          value: CompactValueDecoded;
          dataHashHex?: string;
          fullyConsumed: boolean;
      }
    | {
          tag: 2;
          variant: "TxOut_AddrHash28_AdaOnly";
          stakeCred: CredentialKind;
          payHashHex: string;
          addr28: Uint8Array;
          lovelace: bigint;
          fullyConsumed: boolean;
      }
    | {
          tag: 3;
          variant: "TxOut_AddrHash28_AdaOnly_DataHash32";
          stakeCred: CredentialKind;
          payHashHex: string;
          addr28: Uint8Array;
          lovelace: bigint;
          dataHash32Hex: string;
          fullyConsumed: boolean;
      }
    | {
          tag: 4;
          variant: "TxOutCompactDatum";
          addrRaw: Uint8Array;
          addr: CompactAddrDecoded | null;
          value: CompactValueDecoded;
          /** Inline BinaryData = MemPack ShortByteString (opaque Plutus Data CBOR). */
          inlineDatum: Uint8Array;
          fullyConsumed: boolean;
      }
    | {
          tag: 5;
          variant: "TxOutCompactRefScript";
          addrRaw: Uint8Array;
          addr: CompactAddrDecoded | null;
          value: CompactValueDecoded;
          datum: DatumDecoded;
          script: ScriptDecoded;
          fullyConsumed: boolean;
      }
    | {
          tag: number;
          variant: "unknown";
          fullyConsumed: false;
      };

/** MemPack Datum era: tag0 NoDatum | tag1 DataHash(32) | tag2 BinaryData SBS. */
export type DatumDecoded =
    | { kind: "noDatum" }
    | { kind: "datumHash"; hashHex: string }
    | { kind: "inline"; bytes: Uint8Array };

/**
 * MemPack AlonzoScript:
 *   tag0 NativeScript = Timelock MemoBytes ≈ ShortByteString of CBOR
 *   tag1 PlutusScript = langTag (0=V1,1=V2,…) + PlutusBinary SBS
 */
export type ScriptDecoded =
    | { kind: "native"; bytes: Uint8Array }
    | { kind: "plutus"; language: number; bytes: Uint8Array };

export type UtxoEntryPartial = {
    txIn: TxInDecoded;
    txOut: TxOutDecoded;
    /** Always false until full TxOut → address/value DB insert path. */
    utxoExtracted: false;
};

// ── MemPack primitives ──────────────────────────────────────────────────────

/**
 * MemPack VarLen / Length (unsigned).
 *
 * NOT standard LEB128 (LSB-first). lehins/mempack uses MSB-first 7-bit groups:
 *   packIntoCont7 writes high chunks first with continuation bit 0x80;
 *   unpack7BitVarLen does `acc = (acc << 7) | (b & 0x7f)` until cont bit clear.
 *
 * Examples: 45 → `2d`; 208 → `8150`; 218 → `815a`.
 */
export function readVarLenU(
    buf: Uint8Array,
    off: number,
): DecodeResult<bigint> {
    if (off >= buf.length) return { ok: false, error: "varLen eof", off };
    let acc = 0n;
    let pos = off;
    for (let i = 0; i < 10; i++) {
        if (pos >= buf.length) {
            return { ok: false, error: "varLen truncated", off: pos };
        }
        const b = buf[pos++]!;
        acc = (acc << 7n) | BigInt(b & 0x7f);
        if ((b & 0x80) === 0) return { ok: true, value: acc, next: pos };
    }
    return { ok: false, error: "varLen too long", off };
}

/** packTagM / unpackTagM = single Word8. */
export function readTag(buf: Uint8Array, off: number): DecodeResult<number> {
    if (off >= buf.length) return { ok: false, error: "tag eof", off };
    return { ok: true, value: buf[off]!, next: off + 1 };
}

/** ShortByteString / CompactAddr = Length(VarLen) + bytes. */
export function readShortByteString(
    buf: Uint8Array,
    off: number,
    maxLen = 65_536,
): DecodeResult<Uint8Array> {
    const lenR = readVarLenU(buf, off);
    if (!lenR.ok) return lenR;
    if (lenR.value > BigInt(maxLen)) {
        return {
            ok: false,
            error: `sbs len ${lenR.value} > max ${maxLen}`,
            off,
        };
    }
    const n = Number(lenR.value);
    const start = lenR.next;
    const end = start + n;
    if (end > buf.length) {
        return { ok: false, error: "sbs truncated", off: start };
    }
    return { ok: true, value: buf.subarray(start, end), next: end };
}

/** Host-endian Word16 (MemPack / Mary MA offsets — LE on x86). */
export function readWord16LE(
    buf: Uint8Array,
    off: number,
): DecodeResult<number> {
    if (off + 2 > buf.length) {
        return { ok: false, error: "w16le eof", off };
    }
    return {
        ok: true,
        value: buf[off]! | (buf[off + 1]! << 8),
        next: off + 2,
    };
}

/** Host-endian Word64 (MemPack MA quantities — LE on x86). */
export function readWord64LE(
    buf: Uint8Array,
    off: number,
): DecodeResult<bigint> {
    if (off + 8 > buf.length) {
        return { ok: false, error: "w64le eof", off };
    }
    const lo =
        buf[off]! |
        (buf[off + 1]! << 8) |
        (buf[off + 2]! << 16) |
        (buf[off + 3]! << 24);
    const hi =
        buf[off + 4]! |
        (buf[off + 5]! << 8) |
        (buf[off + 6]! << 16) |
        (buf[off + 7]! << 24);
    // >>> 0 for unsigned 32-bit
    const value =
        (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return { ok: true, value, next: off + 8 };
}

/** CompactForm Coin = packTagM 0 >> VarLen Word64. */
export function readCompactFormCoin(
    buf: Uint8Array,
    off: number,
): DecodeResult<bigint> {
    const tag = readTag(buf, off);
    if (!tag.ok) return tag;
    if (tag.value !== 0) {
        return {
            ok: false,
            error: `CompactForm Coin unexpected tag ${tag.value}`,
            off,
        };
    }
    return readVarLenU(buf, tag.next);
}

/**
 * MemPack BinaryData = ShortByteString (opaque Plutus Data CBOR bytes).
 * Proven on preprod tables: tag4 rest is always one SBS to EOF.
 */
export function decodeBinaryData(
    buf: Uint8Array,
    off: number,
): DecodeResult<Uint8Array> {
    return readShortByteString(buf, off);
}

/**
 * MemPack Datum era:
 *   packTagM 0 → NoDatum
 *   packTagM 1 → DatumHash (32-byte SafeHash / DataHash)
 *   packTagM 2 → Datum BinaryData (SBS)
 */
export function decodeDatum(
    buf: Uint8Array,
    off: number,
): DecodeResult<DatumDecoded> {
    const tag = readTag(buf, off);
    if (!tag.ok) return tag;
    if (tag.value === 0) {
        return { ok: true, value: { kind: "noDatum" }, next: tag.next };
    }
    if (tag.value === 1) {
        const start = tag.next;
        const end = start + 32;
        if (end > buf.length) {
            return { ok: false, error: "datum hash truncated", off: start };
        }
        return {
            ok: true,
            value: {
                kind: "datumHash",
                hashHex: bytesToHex(buf.subarray(start, end)),
            },
            next: end,
        };
    }
    if (tag.value === 2) {
        const sbs = decodeBinaryData(buf, tag.next);
        if (!sbs.ok) return sbs;
        return {
            ok: true,
            value: { kind: "inline", bytes: sbs.value },
            next: sbs.next,
        };
    }
    return {
        ok: false,
        error: `Datum unexpected tag ${tag.value}`,
        off,
    };
}

/**
 * MemPack AlonzoScript (Babbage era Script):
 *   packTagM 0 → NativeScript (Timelock MemoBytes ≈ SBS of CBOR)
 *   packTagM 1 → PlutusScript:
 *     packTagM lang (0=V1, 1=V2, …) >> PlutusBinary SBS
 *
 * Bodies are opaque — no Plutus interpreter.
 */
export function decodeScript(
    buf: Uint8Array,
    off: number,
): DecodeResult<ScriptDecoded> {
    const st = readTag(buf, off);
    if (!st.ok) return st;
    if (st.value === 0) {
        const sbs = readShortByteString(buf, st.next);
        if (!sbs.ok) return sbs;
        return {
            ok: true,
            value: { kind: "native", bytes: sbs.value },
            next: sbs.next,
        };
    }
    if (st.value === 1) {
        const lt = readTag(buf, st.next);
        if (!lt.ok) return lt;
        const sbs = readShortByteString(buf, lt.next);
        if (!sbs.ok) return sbs;
        return {
            ok: true,
            value: {
                kind: "plutus",
                language: lt.value,
                bytes: sbs.value,
            },
            next: sbs.next,
        };
    }
    return {
        ok: false,
        error: `AlonzoScript unexpected tag ${st.value}`,
        off,
    };
}

/** Credential = packTagM 0 script | 1 key  >> 28-byte hash. */
export function readCredential(
    buf: Uint8Array,
    off: number,
): DecodeResult<{ kind: CredentialKind; hash: Uint8Array }> {
    const tag = readTag(buf, off);
    if (!tag.ok) return tag;
    if (tag.value !== 0 && tag.value !== 1) {
        return {
            ok: false,
            error: `Credential unexpected tag ${tag.value}`,
            off,
        };
    }
    const start = tag.next;
    const end = start + 28;
    if (end > buf.length) {
        return { ok: false, error: "credential hash truncated", off: start };
    }
    return {
        ok: true,
        value: {
            kind: tag.value === 0 ? "script" : "key",
            hash: buf.subarray(start, end),
        },
        next: end,
    };
}

// ── CompactAddr (serialiseAddr) ─────────────────────────────────────────────

/**
 * Decode CompactAddr bytes from Address.hs putAddr / decodeAddrStateLenientT.
 *
 * Header bits (Shelley):
 *   bit0 network (1=mainnet)
 *   bit4 payment is script
 *   bit5 stake is script (base) OR enterprise when bit6 set
 *   bit6 not base (pointer or enterprise)
 * Byron: header 0x82
 */
export function decodeCompactAddr(
    bytes: Uint8Array,
): DecodeResult<CompactAddrDecoded> {
    if (bytes.length < 1) {
        return { ok: false, error: "empty CompactAddr", off: 0 };
    }
    const h = bytes[0]!;
    // Byron: 0b10000010
    if (h === 0x82 || (h & 0x80) !== 0) {
        return {
            ok: true,
            value: { kind: "byron", header: h, rawLen: bytes.length },
            next: bytes.length,
        };
    }
    // unused Shelley header bits 2–3 must be 0 (headerNonShelleyBits check)
    if ((h & 0x0c) !== 0) {
        return {
            ok: false,
            error: `invalid Shelley header bits: 0x${h.toString(16)}`,
            off: 0,
        };
    }

    const network: NetworkId = (h & 1) !== 0 ? "mainnet" : "testnet";
    const payScript = (h & (1 << 4)) !== 0;
    const bit5 = (h & (1 << 5)) !== 0;
    const notBase = (h & (1 << 6)) !== 0;

    if (!notBase) {
        // base: header + pay28 + stake28 = 57
        if (bytes.length !== 57) {
            return {
                ok: false,
                error: `base addr len ${bytes.length} !== 57`,
                off: 0,
            };
        }
        return {
            ok: true,
            value: {
                kind: "base",
                network,
                payScript,
                stakeScript: bit5,
                payHashHex: bytesToHex(bytes.subarray(1, 29)),
                stakeHashHex: bytesToHex(bytes.subarray(29, 57)),
            },
            next: 57,
        };
    }

    if (bit5) {
        // enterprise (StakeRefNull): header + pay28 = 29
        if (bytes.length !== 29) {
            return {
                ok: false,
                error: `enterprise addr len ${bytes.length} !== 29`,
                off: 0,
            };
        }
        return {
            ok: true,
            value: {
                kind: "enterprise",
                network,
                payScript,
                payHashHex: bytesToHex(bytes.subarray(1, 29)),
            },
            next: 29,
        };
    }

    // pointer: header + pay28 + varlen slot/txIx/certIx
    if (bytes.length < 29) {
        return { ok: false, error: "pointer addr too short", off: 0 };
    }
    let p = 29;
    const slot = readVarLenU(bytes, p);
    if (!slot.ok) return slot;
    p = slot.next;
    const txIx = readVarLenU(bytes, p);
    if (!txIx.ok) return txIx;
    p = txIx.next;
    const certIx = readVarLenU(bytes, p);
    if (!certIx.ok) return certIx;
    p = certIx.next;
    if (p !== bytes.length) {
        return {
            ok: false,
            error: `pointer leftover ${bytes.length - p} bytes`,
            off: p,
        };
    }
    return {
        ok: true,
        value: {
            kind: "pointer",
            network,
            payScript,
            payHashHex: bytesToHex(bytes.subarray(1, 29)),
            slot: slot.value,
            txIx: txIx.value,
            certIx: certIx.value,
        },
        next: p,
    };
}

// ── MultiAsset compact rep (Mary/Value.hs) ──────────────────────────────────

/**
 * Decode CompactValueMultiAsset `rep` ShortByteString.
 *
 * Layout (host-endian Word16/Word64 — LE on x86):
 *   A) n × Word64 quantities
 *   B) n × Word16 policyId offsets (into whole rep)
 *   C) n × Word16 assetName offsets (into whole rep)
 *   D) policyId blob (28B each, unique)
 *   E) asset name blob (sorted, unique) + padding
 *
 * Asset name length = next greater name offset − this offset
 * (or rep.length − offset). Empty names point at end of E.
 */
export function decodeMultiAssetRep(
    rep: Uint8Array,
    numAssets: number,
): DecodeResult<MultiAssetRepDecoded> {
    if (numAssets < 0 || numAssets > 1_000_000) {
        return { ok: false, error: `numAssets ${numAssets}`, off: 0 };
    }
    const n = numAssets;
    const headerBytes = 12 * n; // 8 + 2 + 2
    if (rep.length < headerBytes) {
        return {
            ok: false,
            error: `rep short ${rep.length} < ${headerBytes}`,
            off: 0,
        };
    }

    const qtys: bigint[] = [];
    const polOff: number[] = [];
    const nameOff: number[] = [];
    let p = 0;
    for (let i = 0; i < n; i++) {
        const q = readWord64LE(rep, p);
        if (!q.ok) return q;
        qtys.push(q.value);
        p = q.next;
    }
    for (let i = 0; i < n; i++) {
        const o = readWord16LE(rep, p);
        if (!o.ok) return o;
        polOff.push(o.value);
        p = o.next;
    }
    for (let i = 0; i < n; i++) {
        const o = readWord16LE(rep, p);
        if (!o.ok) return o;
        nameOff.push(o.value);
        p = o.next;
    }

    // unique sorted name offsets → lengths (Mary from())
    const uniqueNameOffs = [...new Set(nameOff)].sort((a, b) => a - b);
    const nameLen = new Map<number, number>();
    for (let i = 0; i < uniqueNameOffs.length; i++) {
        const cur = uniqueNameOffs[i]!;
        const next =
            i + 1 < uniqueNameOffs.length
                ? uniqueNameOffs[i + 1]!
                : rep.length;
        nameLen.set(cur, Math.max(0, next - cur));
    }

    const assets: MultiAssetTriple[] = [];
    for (let i = 0; i < n; i++) {
        const po = polOff[i]!;
        const no = nameOff[i]!;
        if (po + 28 > rep.length) {
            return {
                ok: false,
                error: `policy offset ${po} OOB`,
                off: po,
            };
        }
        const len = nameLen.get(no) ?? 0;
        if (no + len > rep.length) {
            return {
                ok: false,
                error: `name offset ${no}+${len} OOB`,
                off: no,
            };
        }
        assets.push({
            policyIdHex: bytesToHex(rep.subarray(po, po + 28)),
            assetNameHex: bytesToHex(rep.subarray(no, no + len)),
            quantity: qtys[i]!,
        });
    }

    return {
        ok: true,
        value: { numAssets: n, assets },
        next: rep.length,
    };
}

/**
 * Mary CompactValue:
 *   tag0 → VarLen lovelace
 *   tag1 → VarLen lovelace ‖ VarLen numMA ‖ ShortByteString rep
 */
export function readCompactValue(
    buf: Uint8Array,
    off: number,
): DecodeResult<CompactValueDecoded> {
    const tag = readTag(buf, off);
    if (!tag.ok) return tag;
    if (tag.value === 0) {
        const coin = readVarLenU(buf, tag.next);
        if (!coin.ok) return coin;
        return {
            ok: true,
            value: { kind: "ada", lovelace: coin.value },
            next: coin.next,
        };
    }
    if (tag.value === 1) {
        const coin = readVarLenU(buf, tag.next);
        if (!coin.ok) return coin;
        const nma = readVarLenU(buf, coin.next);
        if (!nma.ok) return nma;
        const numAssets = Number(nma.value);
        const repS = readShortByteString(buf, nma.next);
        if (!repS.ok) return repS;
        const ma = decodeMultiAssetRep(repS.value, numAssets);
        if (!ma.ok) {
            // keep lovelace + empty assets but report failure as decode error
            return ma;
        }
        return {
            ok: true,
            value: {
                kind: "multiAsset",
                lovelace: coin.value,
                numAssets,
                assets: ma.value.assets,
                repFullyDecoded: true,
            },
            next: repS.next,
        };
    }
    return {
        ok: false,
        error: `CompactValue unexpected tag ${tag.value}`,
        off,
    };
}

// ── TxIn / TxOut ────────────────────────────────────────────────────────────

/**
 * Tables map key is raw MemPack TxIn bytes (not CBOR-wrapped again inside the
 * map key bstr). TxIn = TxId(32) || TxIx(Word16). Endianness of TxIx in the
 * 34-byte key is big-endian (proven on preprod e305 keys).
 */
export function decodeTxInKey(key: Uint8Array): DecodeResult<TxInDecoded> {
    if (key.length !== 34) {
        return {
            ok: false,
            error: `TxIn key len ${key.length} !== 34`,
            off: 0,
        };
    }
    const txIdHex = bytesToHex(key.subarray(0, 32));
    const txIx = (key[32]! << 8) | key[33]!;
    return {
        ok: true,
        value: { txIdHex, txIx },
        next: 34,
    };
}

function decodeAddrField(
    raw: Uint8Array,
): { addr: CompactAddrDecoded | null; addrOk: boolean } {
    const d = decodeCompactAddr(raw);
    if (!d.ok) return { addr: null, addrOk: false };
    return { addr: d.value, addrOk: true };
}

function valueFullyConsumed(
    value: CompactValueDecoded,
    valueEnd: number,
    blobLen: number,
): boolean {
    if (value.kind === "ada") return valueEnd === blobLen;
    return value.repFullyDecoded && valueEnd === blobLen;
}

/** Decode one MemPack TxOut value blob (Babbage-compatible tags 0–5). */
export function decodeTxOutValue(
    val: Uint8Array,
): DecodeResult<TxOutDecoded> {
    if (val.length < 1) {
        return { ok: false, error: "empty TxOut", off: 0 };
    }
    const tagR = readTag(val, 0);
    if (!tagR.ok) return tagR;
    const tag = tagR.value;
    let off = tagR.next;

    if (tag === 0 || tag === 1) {
        const addrRaw = readShortByteString(val, off);
        if (!addrRaw.ok) return addrRaw;
        off = addrRaw.next;
        const { addr } = decodeAddrField(addrRaw.value);
        const value = readCompactValue(val, off);
        if (!value.ok) return value;
        off = value.next;

        if (tag === 0) {
            const fully = valueFullyConsumed(value.value, off, val.length);
            return {
                ok: true,
                value: {
                    tag: 0,
                    variant: "TxOutCompact",
                    addrRaw: addrRaw.value,
                    addr,
                    value: value.value,
                    fullyConsumed: fully,
                },
                next: off,
            };
        }

        // tag 1: DataHash (32 raw bytes) after value when remaining is exactly 32
        let dataHashHex: string | undefined;
        let fully = false;
        if (value.value.kind === "ada" && off + 32 === val.length) {
            dataHashHex = bytesToHex(val.subarray(off, off + 32));
            off += 32;
            fully = true;
        } else if (
            value.value.kind === "multiAsset" &&
            off + 32 === val.length
        ) {
            dataHashHex = bytesToHex(val.subarray(off, off + 32));
            off += 32;
            fully = value.value.repFullyDecoded;
        } else {
            fully = valueFullyConsumed(value.value, off, val.length);
        }
        return {
            ok: true,
            value: {
                tag: 1,
                variant: "TxOutCompactDH",
                addrRaw: addrRaw.value,
                addr,
                value: value.value,
                dataHashHex,
                fullyConsumed: fully,
            },
            next: off,
        };
    }

    if (tag === 2 || tag === 3) {
        const cred = readCredential(val, off);
        if (!cred.ok) return cred;
        off = cred.next;
        if (off + 32 > val.length) {
            return { ok: false, error: "addr28 truncated", off };
        }
        const addr28 = val.subarray(off, off + 32);
        off += 32;
        const coin = readCompactFormCoin(val, off);
        if (!coin.ok) return coin;
        off = coin.next;

        if (tag === 2) {
            return {
                ok: true,
                value: {
                    tag: 2,
                    variant: "TxOut_AddrHash28_AdaOnly",
                    stakeCred: cred.value.kind,
                    payHashHex: bytesToHex(cred.value.hash),
                    addr28,
                    lovelace: coin.value,
                    fullyConsumed: off === val.length,
                },
                next: off,
            };
        }

        if (off + 32 > val.length) {
            return { ok: false, error: "dataHash32 truncated", off };
        }
        const dataHash32Hex = bytesToHex(val.subarray(off, off + 32));
        off += 32;
        return {
            ok: true,
            value: {
                tag: 3,
                variant: "TxOut_AddrHash28_AdaOnly_DataHash32",
                stakeCred: cred.value.kind,
                payHashHex: bytesToHex(cred.value.hash),
                addr28,
                lovelace: coin.value,
                dataHash32Hex,
                fullyConsumed: off === val.length,
            },
            next: off,
        };
    }

    if (tag === 4 || tag === 5) {
        const addrRaw = readShortByteString(val, off);
        if (!addrRaw.ok) return addrRaw;
        off = addrRaw.next;
        const { addr } = decodeAddrField(addrRaw.value);
        const value = readCompactValue(val, off);
        if (!value.ok) return value;
        off = value.next;
        if (tag === 4) {
            // TxOutCompactDatum: addr >> value >> BinaryData (SBS)
            const inline = decodeBinaryData(val, off);
            if (!inline.ok) return inline;
            off = inline.next;
            return {
                ok: true,
                value: {
                    tag: 4,
                    variant: "TxOutCompactDatum",
                    addrRaw: addrRaw.value,
                    addr,
                    value: value.value,
                    inlineDatum: inline.value,
                    fullyConsumed: off === val.length,
                },
                next: off,
            };
        }
        // TxOutCompactRefScript: addr >> value >> Datum >> Script
        const datum = decodeDatum(val, off);
        if (!datum.ok) return datum;
        off = datum.next;
        const script = decodeScript(val, off);
        if (!script.ok) return script;
        off = script.next;
        return {
            ok: true,
            value: {
                tag: 5,
                variant: "TxOutCompactRefScript",
                addrRaw: addrRaw.value,
                addr,
                value: value.value,
                datum: datum.value,
                script: script.value,
                fullyConsumed: off === val.length,
            },
            next: off,
        };
    }

    return {
        ok: true,
        value: { tag, variant: "unknown", fullyConsumed: false },
        next: 1,
    };
}

export function decodeUtxoEntry(
    key: Uint8Array,
    val: Uint8Array,
): DecodeResult<UtxoEntryPartial> {
    const txIn = decodeTxInKey(key);
    if (!txIn.ok) return txIn;
    const txOut = decodeTxOutValue(val);
    if (!txOut.ok) return txOut;
    return {
        ok: true,
        value: {
            txIn: txIn.value,
            txOut: txOut.value,
            utxoExtracted: false,
        },
        next: txOut.next,
    };
}

// ── CBOR map entry streaming helpers (tables head) ──────────────────────────

type CborHdr = {
    major: number;
    ai: number;
    len: number | null;
    next: number;
};

function readCborHdr(buf: Uint8Array, off: number): CborHdr | null {
    if (off >= buf.length) return null;
    const b = buf[off]!;
    const major = b >> 5;
    const ai = b & 0x1f;
    let pos = off + 1;
    let len: number | null = null;
    if (ai < 24) len = ai;
    else if (ai === 24) {
        if (pos >= buf.length) return null;
        len = buf[pos++]!;
    } else if (ai === 25) {
        if (pos + 2 > buf.length) return null;
        len = (buf[pos]! << 8) | buf[pos + 1]!;
        pos += 2;
    } else if (ai === 26) {
        if (pos + 4 > buf.length) return null;
        len =
            ((buf[pos]! << 24) |
                (buf[pos + 1]! << 16) |
                (buf[pos + 2]! << 8) |
                buf[pos + 3]!) >>>
            0;
        pos += 4;
    } else if (ai === 27) {
        if (pos + 8 > buf.length) return null;
        const hi =
            ((buf[pos]! << 24) |
                (buf[pos + 1]! << 16) |
                (buf[pos + 2]! << 8) |
                buf[pos + 3]!) >>>
            0;
        const lo =
            ((buf[pos + 4]! << 24) |
                (buf[pos + 5]! << 16) |
                (buf[pos + 6]! << 8) |
                buf[pos + 7]!) >>>
            0;
        pos += 8;
        len = hi * 2 ** 32 + lo;
    } else if (ai === 31) {
        len = -1;
    } else {
        return null;
    }
    return { major, ai, len, next: pos };
}

export type TablesDecodeStats = {
    scanned: number;
    byTag: Record<number, number>;
    tag2FullyConsumed: number;
    tag0AdaFullyConsumed: number;
    tag0MaFullyConsumed: number;
    addrBase: number;
    addrEnterprise: number;
    addrPointer: number;
    addrByron: number;
    maAssetsDecoded: number;
    decodeErrors: number;
    samples: UtxoEntryPartial[];
    /** Always false — scaffold does not insert UTxO rows. */
    utxoExtracted: false;
};

/**
 * Decode up to `limit` map entries from a tables file head buffer.
 * Expects CBOR array(1) + indefinite map of bstr→bstr (utxohd-mem v1).
 */
export function decodeTablesHeadEntries(
    head: Uint8Array,
    opts: { limit?: number; sampleLimit?: number } = {},
): TablesDecodeStats {
    const limit = opts.limit ?? 2000;
    const sampleLimit = opts.sampleLimit ?? 8;
    const stats: TablesDecodeStats = {
        scanned: 0,
        byTag: {},
        tag2FullyConsumed: 0,
        tag0AdaFullyConsumed: 0,
        tag0MaFullyConsumed: 0,
        addrBase: 0,
        addrEnterprise: 0,
        addrPointer: 0,
        addrByron: 0,
        maAssetsDecoded: 0,
        decodeErrors: 0,
        samples: [],
        utxoExtracted: false,
    };

    let off = 0;
    const top = readCborHdr(head, off);
    if (!top || top.major !== 4) return stats;
    off = top.next;
    const map = readCborHdr(head, off);
    if (!map || map.major !== 5) return stats;
    off = map.next;

    while (off < head.length - 2 && stats.scanned < limit) {
        const kHdr = readCborHdr(head, off);
        if (!kHdr) break;
        if (kHdr.major === 7 && kHdr.ai === 31) break;
        if (kHdr.major !== 2 || kHdr.len == null || kHdr.len < 0) break;
        const key = head.subarray(kHdr.next, kHdr.next + kHdr.len);
        off = kHdr.next + kHdr.len;

        const vHdr = readCborHdr(head, off);
        if (!vHdr || vHdr.major !== 2 || vHdr.len == null || vHdr.len < 0) {
            break;
        }
        const val = head.subarray(vHdr.next, vHdr.next + vHdr.len);
        off = vHdr.next + vHdr.len;

        const entry = decodeUtxoEntry(key, val);
        stats.scanned++;
        if (!entry.ok) {
            stats.decodeErrors++;
            continue;
        }
        const txOut = entry.value.txOut;
        const tag = typeof txOut.tag === "number" ? txOut.tag : -1;
        stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;

        if (txOut.tag === 2 && txOut.fullyConsumed) {
            stats.tag2FullyConsumed++;
        }
        if (txOut.tag === 0 && txOut.fullyConsumed) {
            if (txOut.value.kind === "ada") stats.tag0AdaFullyConsumed++;
            else stats.tag0MaFullyConsumed++;
        }

        // addr + MA stats — narrow by variant (unknown has neither addr nor value)
        if (
            txOut.variant === "TxOutCompact" ||
            txOut.variant === "TxOutCompactDH" ||
            txOut.variant === "TxOutCompactDatum" ||
            txOut.variant === "TxOutCompactRefScript"
        ) {
            const a = txOut.addr;
            if (a?.kind === "base") stats.addrBase++;
            else if (a?.kind === "enterprise") stats.addrEnterprise++;
            else if (a?.kind === "pointer") stats.addrPointer++;
            else if (a?.kind === "byron") stats.addrByron++;
            if (txOut.value.kind === "multiAsset") {
                stats.maAssetsDecoded += txOut.value.assets.length;
            }
        }

        if (stats.samples.length < sampleLimit) {
            stats.samples.push(entry.value);
        }
    }

    return stats;
}

function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++) {
        s += b[i]!.toString(16).padStart(2, "0");
    }
    return s;
}
