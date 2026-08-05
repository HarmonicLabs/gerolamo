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
 *   - tag0 Compact: addr SBS + AdaOnly value fully; MultiAsset body partial
 *   - tag1/3/4/5: tag + addr/value prefix only — datum/script/MA body blocked
 *   - utxoExtracted stays false until full TxOut → DB path exists
 *
 * Sources: docs/a2-utxohd-mem-codec-research.md
 *   - lehins/mempack Tag=Word8, Length=VarLen LEB128, VarLen Word64 LEB128
 *   - cardano-ledger Babbage/Alonzo/Shelley TxOut MemPack
 *   - ouroboros-consensus InMemory.hs tables CBOR map
 */

export type MemPackCursor = {
    buf: Uint8Array;
    off: number;
};

export type DecodeError = { ok: false; error: string; off: number };
export type DecodeOk<T> = { ok: true; value: T; next: number };
export type DecodeResult<T> = DecodeOk<T> | DecodeError;

export type TxInDecoded = {
    txIdHex: string;
    txIx: number;
};

export type CredentialKind = "script" | "key";

export type CompactValueDecoded =
    | { kind: "ada"; lovelace: bigint }
    | { kind: "multiAsset"; lovelace: bigint; restOff: number; restLen: number };

export type TxOutDecoded =
    | {
          tag: 0;
          variant: "TxOutCompact";
          addr: Uint8Array;
          value: CompactValueDecoded;
          fullyConsumed: boolean;
      }
    | {
          tag: 1;
          variant: "TxOutCompactDH";
          addr: Uint8Array;
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
          addr: Uint8Array;
          value: CompactValueDecoded;
          /** Datum bytes remain — not decoded yet. */
          restOff: number;
          restLen: number;
          fullyConsumed: false;
      }
    | {
          tag: 5;
          variant: "TxOutCompactRefScript";
          addr: Uint8Array;
          value: CompactValueDecoded;
          restOff: number;
          restLen: number;
          fullyConsumed: false;
      }
    | {
          tag: number;
          variant: "unknown";
          fullyConsumed: false;
      };

export type UtxoEntryPartial = {
    txIn: TxInDecoded;
    txOut: TxOutDecoded;
    /** Always false until full TxOut → address/value DB insert path. */
    utxoExtracted: false;
};

// ── MemPack primitives ──────────────────────────────────────────────────────

/** LEB128 unsigned (MemPack VarLen Word / Length). */
export function readVarLenU(
    buf: Uint8Array,
    off: number,
): DecodeResult<bigint> {
    if (off >= buf.length) return { ok: false, error: "varLen eof", off };
    let result = 0n;
    let shift = 0n;
    let pos = off;
    for (let i = 0; i < 10; i++) {
        if (pos >= buf.length) {
            return { ok: false, error: "varLen truncated", off: pos };
        }
        const b = buf[pos++]!;
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { ok: true, value: result, next: pos };
        shift += 7n;
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
    maxLen = 256,
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

/** Fixed-width big-endian Word16 (TxIx in tables key bytes). */
export function readWord16BE(
    buf: Uint8Array,
    off: number,
): DecodeResult<number> {
    if (off + 2 > buf.length) {
        return { ok: false, error: "w16 eof", off };
    }
    return {
        ok: true,
        value: (buf[off]! << 8) | buf[off + 1]!,
        next: off + 2,
    };
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
 * Mary CompactValue (no nested CompactForm Coin tag on ada):
 *   tag0 → VarLen lovelace
 *   tag1 → VarLen lovelace + MultiAsset body (rest opaque here)
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
        return {
            ok: true,
            value: {
                kind: "multiAsset",
                lovelace: coin.value,
                restOff: coin.next,
                restLen: buf.length - coin.next,
            },
            next: coin.next, // body not consumed
        };
    }
    return {
        ok: false,
        error: `CompactValue unexpected tag ${tag.value}`,
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
        const addr = readShortByteString(val, off);
        if (!addr.ok) return addr;
        off = addr.next;
        const value = readCompactValue(val, off);
        if (!value.ok) return value;
        off = value.next;

        if (tag === 0) {
            const fully =
                value.value.kind === "ada" && off === val.length;
            return {
                ok: true,
                value: {
                    tag: 0,
                    variant: "TxOutCompact",
                    addr: addr.value,
                    value: value.value,
                    fullyConsumed: fully,
                },
                next: off,
            };
        }

        // tag 1: optional dataHash (32 bytes) after value when ada-only;
        // multiAsset leaves rest opaque.
        let dataHashHex: string | undefined;
        let fully = false;
        if (value.value.kind === "ada" && off + 32 <= val.length) {
            // DataHash is MemPack of SafeHash — typically raw 32 bytes after value
            // when remaining is exactly 32. If more remains, leave partial.
            if (off + 32 === val.length) {
                dataHashHex = bytesToHex(val.subarray(off, off + 32));
                off += 32;
                fully = true;
            }
        }
        return {
            ok: true,
            value: {
                tag: 1,
                variant: "TxOutCompactDH",
                addr: addr.value,
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
        const addr = readShortByteString(val, off);
        if (!addr.ok) return addr;
        off = addr.next;
        const value = readCompactValue(val, off);
        if (!value.ok) return value;
        // datum / script remain
        const restOff =
            value.value.kind === "multiAsset"
                ? value.value.restOff
                : value.next;
        if (tag === 4) {
            return {
                ok: true,
                value: {
                    tag: 4,
                    variant: "TxOutCompactDatum",
                    addr: addr.value,
                    value: value.value,
                    restOff,
                    restLen: val.length - restOff,
                    fullyConsumed: false,
                },
                next: restOff,
            };
        }
        return {
            ok: true,
            value: {
                tag: 5,
                variant: "TxOutCompactRefScript",
                addr: addr.value,
                value: value.value,
                restOff,
                restLen: val.length - restOff,
                fullyConsumed: false,
            },
            next: restOff,
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
        // 64-bit — only support values that fit JS number safely for lengths
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
        len = -1; // indefinite
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
        // break
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
        const tag =
            typeof entry.value.txOut.tag === "number"
                ? entry.value.txOut.tag
                : -1;
        stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;

        if (
            entry.value.txOut.tag === 2 &&
            entry.value.txOut.fullyConsumed
        ) {
            stats.tag2FullyConsumed++;
        }
        if (
            entry.value.txOut.tag === 0 &&
            entry.value.txOut.fullyConsumed
        ) {
            stats.tag0AdaFullyConsumed++;
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
