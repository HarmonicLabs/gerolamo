/**
 * Minimal deterministic tar (POSIX ustar) writer for Mithril archives: regular files only,
 * mode 0644, owner 0/0, mtime 0, no user or group names. Two runs over the same files give the
 * same bytes, so archives can be rebuilt and compared.
 */

const BLOCK = 512;

function octal(value: number, width: number): string {
    // width - 1 octal digits followed by NUL
    const s = value.toString(8);
    if (s.length > width - 1) throw new Error(`tar: value ${value} does not fit ${width} bytes`);
    return s.padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number): Uint8Array {
    const enc = new TextEncoder();
    let nameField = name;
    let prefix = "";
    if (enc.encode(name).length > 100) {
        const cut = name.lastIndexOf("/", 155);
        if (cut <= 0 || enc.encode(name.slice(cut + 1)).length > 100) throw new Error(`tar: name too long: ${name}`);
        prefix = name.slice(0, cut);
        nameField = name.slice(cut + 1);
    }
    const h = new Uint8Array(BLOCK);
    const put = (off: number, s: string) => h.set(enc.encode(s), off);
    put(0, nameField);
    put(100, octal(0o644, 8));
    put(108, octal(0, 8));
    put(116, octal(0, 8));
    put(124, octal(size, 12));
    put(136, octal(0, 12));
    put(148, "        "); // checksum placeholder
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    put(345, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    put(148, sum.toString(8).padStart(6, "0") + "\0 ");
    return h;
}

export type TarEntry = { name: string; data: Uint8Array };

/** A complete tar archive (entries in the given order, then two zero blocks). */
export function buildTar(entries: TarEntry[]): Uint8Array {
    let total = 2 * BLOCK;
    for (const e of entries) total += BLOCK + Math.ceil(e.data.length / BLOCK) * BLOCK;
    const out = new Uint8Array(total);
    let o = 0;
    for (const e of entries) {
        out.set(header(e.name, e.data.length), o);
        o += BLOCK;
        out.set(e.data, o);
        o += Math.ceil(e.data.length / BLOCK) * BLOCK;
    }
    return out;
}

/** Entries of an uncompressed tar archive (regular files only; enough to check our own archives). */
export function readTar(tar: Uint8Array): TarEntry[] {
    const dec = new TextDecoder();
    const field = (b: Uint8Array, off: number, len: number) => {
        const s = b.subarray(off, off + len);
        const z = s.indexOf(0);
        return dec.decode(z >= 0 ? s.subarray(0, z) : s);
    };
    const out: TarEntry[] = [];
    let o = 0;
    while (o + BLOCK <= tar.length) {
        const h = tar.subarray(o, o + BLOCK);
        if (h.every((b) => b === 0)) break;
        const name = field(h, 0, 100);
        const prefix = field(h, 345, 155);
        const size = parseInt(field(h, 124, 12).trim() || "0", 8);
        const type = String.fromCharCode(h[156]!);
        o += BLOCK;
        if (type === "0" || type === "\0") out.push({ name: prefix ? `${prefix}/${name}` : name, data: tar.slice(o, o + size) });
        o += Math.ceil(size / BLOCK) * BLOCK;
    }
    return out;
}
