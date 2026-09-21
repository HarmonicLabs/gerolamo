/** Minimal CBOR walking for block bytes: element byte ranges without decoding values. Pure TS. */

export function headLen(b: Uint8Array, p: number): number {
    const ai = b[p]! & 0x1f;
    if (ai < 24) return 1;
    if (ai === 24) return 2;
    if (ai === 25) return 3;
    if (ai === 26) return 5;
    if (ai === 27) return 9;
    if (ai === 31) return 1;
    throw new Error(`reserved CBOR additional info ${ai} at ${p}`);
}

export function argAt(b: Uint8Array, p: number): number | undefined {
    const ai = b[p]! & 0x1f;
    if (ai < 24) return ai;
    const dv = new DataView(b.buffer, b.byteOffset + p + 1);
    if (ai === 24) return dv.getUint8(0);
    if (ai === 25) return dv.getUint16(0, false);
    if (ai === 26) return dv.getUint32(0, false);
    if (ai === 27) return Number(dv.getBigUint64(0, false));
    return undefined;
}

/** Encoded length of the CBOR item at p (nested, definite and indefinite). */
export function itemLen(b: Uint8Array, p: number): number {
    const start = p;
    const stack: number[] = [1];
    while (stack.length) {
        if (stack[stack.length - 1] === 0) { stack.pop(); continue; }
        if (b[p] === 0xff) { p += 1; stack.pop(); continue; }
        const major = b[p]! >> 5, head = headLen(b, p), arg = argAt(b, p);
        stack[stack.length - 1]!--;
        switch (major) {
            case 0: case 1: case 7: p += head; break;
            case 2: case 3: if (arg === undefined) { p += head; stack.push(Infinity); } else p += head + arg; break;
            case 4: p += head; stack.push(arg === undefined ? Infinity : arg); break;
            case 5: p += head; stack.push(arg === undefined ? Infinity : arg * 2); break;
            case 6: p += head; stack.push(1); break;
            default: throw new Error(`bad CBOR major ${major}`);
        }
    }
    return p - start;
}

/** Byte ranges of the elements of a definite-length array starting at p. */
export function arrayElements(b: Uint8Array, p: number): Array<{ start: number; end: number }> {
    if (b[p]! >> 5 !== 4) throw new Error(`not an array at ${p}`);
    const n = argAt(b, p);
    let q = p + headLen(b, p);
    const out: Array<{ start: number; end: number }> = [];
    if (n === undefined) { while (b[q] !== 0xff) { const l = itemLen(b, q); out.push({ start: q, end: q + l }); q += l; } return out; }
    for (let i = 0; i < n; i++) { const l = itemLen(b, q); out.push({ start: q, end: q + l }); q += l; }
    return out;
}

export function uintAt(b: Uint8Array, p: number): bigint {
    if (b[p]! >> 5 !== 0) throw new Error(`expected uint at ${p}`);
    const ai = b[p]! & 0x1f;
    if (ai < 24) return BigInt(ai);
    const dv = new DataView(b.buffer, b.byteOffset + p + 1);
    if (ai === 24) return BigInt(dv.getUint8(0));
    if (ai === 25) return BigInt(dv.getUint16(0, false));
    if (ai === 26) return BigInt(dv.getUint32(0, false));
    return dv.getBigUint64(0, false);
}

export function bytesAt(b: Uint8Array, p: number): Uint8Array {
    if (b[p]! >> 5 !== 2) throw new Error(`expected bytes at ${p}`);
    const n = argAt(b, p)!;
    const s = p + headLen(b, p);
    return b.slice(s, s + n);
}
