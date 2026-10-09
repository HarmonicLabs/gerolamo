/**
 * Minimal reader for the vendored `.tar.gz` vector archives: gunzip with Bun, then walk the
 * 512-byte tar records. Handles ustar names (prefix + name), GNU long names (`L` records) and pax
 * `path` headers, which the Blueprint archive needs (its paths run to 235 characters). Regular
 * files only; directories and links are skipped.
 */

function cString(b: Uint8Array, off: number, len: number): string {
    let end = off;
    while (end < off + len && b[end] !== 0) end++;
    return new TextDecoder().decode(b.subarray(off, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
    const s = cString(b, off, len).trim();
    return s ? parseInt(s, 8) : 0;
}

/** Every regular file of a gzipped tar archive, by its path inside the archive. */
export function readTarGz(gz: Uint8Array): Map<string, Uint8Array> {
    const tar = Bun.gunzipSync(new Uint8Array(gz));
    const files = new Map<string, Uint8Array>();
    let off = 0;
    let longName: string | null = null;
    while (off + 512 <= tar.length) {
        const h = tar.subarray(off, off + 512);
        if (h.every((x) => x === 0)) break;
        const size = octal(h, 124, 12);
        const type = String.fromCharCode(h[156] || 0x30);
        const dataOff = off + 512;
        const data = tar.subarray(dataOff, dataOff + size);
        off = dataOff + Math.ceil(size / 512) * 512;
        if (type === "L") { longName = cString(data, 0, data.length); continue; }
        if (type === "x") {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
            if (m) longName = m[1]!;
            continue;
        }
        if (type === "g") continue;
        let name = longName ?? cString(h, 0, 100);
        if (longName == null && cString(h, 257, 5) === "ustar") {
            const prefix = cString(h, 345, 155);
            if (prefix) name = `${prefix}/${name}`;
        }
        longName = null;
        if (type === "0" || type === "\0") files.set(name, data);
    }
    return files;
}
