/**
 * Minimal CBOR walker over raw bytes (no object model): item heads, skipping, and slices.
 * The Plutus replay scans every block of a chain with it to find redeemers without
 * parsing blocks with the ledger library (~50× faster).
 */
export interface Head { major: number; /** argument (length / value); -1 = indefinite */ arg: number; /** first byte after the head */ next: number }

export function head(b: Uint8Array, p: number): Head {
    const ib = b[p]!;
    const major = ib >> 5, ai = ib & 31;
    if (ai < 24) return { major, arg: ai, next: p + 1 };
    if (ai === 24) return { major, arg: b[p + 1]!, next: p + 2 };
    if (ai === 25) return { major, arg: (b[p + 1]! << 8) | b[p + 2]!, next: p + 3 };
    if (ai === 26) return { major, arg: ((b[p + 1]! << 24) >>> 0) + ((b[p + 2]! << 16) | (b[p + 3]! << 8) | b[p + 4]!), next: p + 5 };
    if (ai === 27) {
        let v = 0;
        for (let i = 1; i <= 8; i++) v = v * 256 + b[p + i]!;
        return { major, arg: v, next: p + 9 };
    }
    if (ai === 31) return { major, arg: -1, next: p + 1 };
    throw new Error(`cbor: bad additional info ${ai} at ${p}`);
}

/** Position after the item starting at `p`. */
export function skip(b: Uint8Array, p: number): number {
    const h = head(b, p);
    switch (h.major) {
        case 0: case 1: case 7: return h.next;
        case 2: case 3: {
            if (h.arg >= 0) return h.next + h.arg;
            let q = h.next;
            while (b[q] !== 0xff) q = skip(b, q);
            return q + 1;
        }
        case 4: case 5: {
            const per = h.major === 5 ? 2 : 1;
            let q = h.next;
            if (h.arg >= 0) { for (let i = 0; i < h.arg * per; i++) q = skip(b, q); return q; }
            while (b[q] !== 0xff) q = skip(b, q);
            return q + 1;
        }
        case 6: return skip(b, h.next);
    }
    throw new Error("cbor: unreachable");
}

/** Elements (start offsets) of the array or map (keys and values interleaved) at `p`; tag 258 unwrapped. */
export function items(b: Uint8Array, p: number): { starts: number[]; end: number; major: number } {
    let h = head(b, p);
    while (h.major === 6) h = head(b, h.next);
    if (h.major !== 4 && h.major !== 5) throw new Error(`cbor: expected array/map at ${p}, major ${h.major}`);
    const per = h.major === 5 ? 2 : 1;
    const starts: number[] = [];
    let q = h.next;
    if (h.arg >= 0) {
        for (let i = 0; i < h.arg * per; i++) { starts.push(q); q = skip(b, q); }
    } else {
        while (b[q] !== 0xff) { starts.push(q); q = skip(b, q); }
        q++;
    }
    return { starts, end: q, major: h.major };
}

export function uint(b: Uint8Array, p: number): number {
    const h = head(b, p);
    if (h.major !== 0) throw new Error(`cbor: expected uint at ${p}`);
    return h.arg;
}

export interface RedeemerSummary { tag: number; index: number; mem: number; cpu: number }

/** Redeemers of a witness set (array or Conway map form), or [] when it has none. */
export function witnessRedeemers(b: Uint8Array, wsStart: number): RedeemerSummary[] {
    const m = items(b, wsStart);
    for (let i = 0; i < m.starts.length; i += 2) {
        if (uint(b, m.starts[i]!) !== 5) continue;
        const r = items(b, m.starts[i + 1]!);
        const out: RedeemerSummary[] = [];
        if (r.major === 4) {
            for (const s of r.starts) {
                const e = items(b, s).starts;
                const eu = items(b, e[3]!).starts;
                out.push({ tag: uint(b, e[0]!), index: uint(b, e[1]!), mem: uint(b, eu[0]!), cpu: uint(b, eu[1]!) });
            }
        } else {
            for (let j = 0; j < r.starts.length; j += 2) {
                const k = items(b, r.starts[j]!).starts;
                const v = items(b, r.starts[j + 1]!).starts;
                const eu = items(b, v[1]!).starts;
                out.push({ tag: uint(b, k[0]!), index: uint(b, k[1]!), mem: uint(b, eu[0]!), cpu: uint(b, eu[1]!) });
            }
        }
        return out;
    }
    return [];
}

/**
 * Shelley+ block (`[era, [header, bodies, witnesses, aux, invalid?]]`): per transaction the body
 * slice, the witness-set start and its redeemers, and the invalid-transaction indices.
 */
export function scanBlock(b: Uint8Array): { era: number; bodies: Array<[number, number]>; witnessStarts: number[]; invalid: Set<number> } | null {
    const env = items(b, 0).starts;
    const era = uint(b, env[0]!);
    if (era < 2) return null;
    const blk = items(b, env[1]!).starts;
    const bodiesArr = items(b, blk[1]!);
    const bodies: Array<[number, number]> = bodiesArr.starts.map((s) => [s, skip(b, s)]);
    const witnessStarts = items(b, blk[2]!).starts;
    const invalid = new Set<number>();
    if (blk.length > 4) for (const s of items(b, blk[4]!).starts) invalid.add(uint(b, s));
    return { era, bodies, witnessStarts, invalid };
}
