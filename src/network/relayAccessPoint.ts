/**
 * Relay access points and IP address helpers, following ouroboros-network's
 * `RelayAccessPoint` / `LedgerRelayAccessPoint` (api/lib/Ouroboros/Network/PeerSelection/RelayAccessPoint.hs):
 *
 *   address  an IPv4 or IPv6 literal + port
 *   domain   a DNS name + port (A / AAAA lookup)
 *   srv      a DNS SRV name (the SRV records carry the ports)
 *
 * Topology and snapshot JSON: `{ "address": …, "port": … }` is an IP literal when the address
 * parses as one, else a domain; an object without `port` is an SRV domain. Ledger relays (pool
 * registration certificates) map as ouroboros-consensus `relayToLedgerRelayAccessPoint` does:
 * SingleHostAddr needs a port and an address (IPv4 preferred), SingleHostName without a port and
 * MultiHostName are SRV domains, and those get the CIP-0155 prefix `_cardano._tcp.` when used
 * (`prefixLedgerRelayAccessPoint`; topology SRV names are used as written).
 */
import { isIP } from "node:net";

export type RelayAccessPoint =
    | { kind: "address"; host: string; port: number }
    | { kind: "domain"; host: string; port: number }
    | { kind: "srv"; host: string };

/** cardano-diffusion `Cardano.Network.Diffusion.Configuration.srvPrefix`. */
export const CARDANO_SRV_PREFIX = "_cardano._tcp";

export function validPort(p: unknown): p is number {
    return typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535;
}

/** Strip `[…]` and an IPv6 zone id; unmap `::ffff:a.b.c.d`; canonical (RFC 5952) IPv6. Non-IPs pass through trimmed. */
export function normalizeHost(host: string): string {
    let h = String(host).trim();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    const pct = h.indexOf("%");
    if (pct > 0 && isIP(h.slice(0, pct)) === 6) h = h.slice(0, pct);
    if (isIP(h) === 6) {
        const b = ipv6ToBytes(h);
        if (b && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
        return b ? ipv6FromBytes(b) : h.toLowerCase();
    }
    return h;
}

export function ipFamily(host: string): 0 | 4 | 6 {
    return isIP(normalizeHost(host)) as 0 | 4 | 6;
}

/** `host:port`, IPv6 literals bracketed (`[2001:db8::1]:3001`). */
export function formatHostPort(host: string, port: number | bigint): string {
    const h = normalizeHost(host);
    return `${isIP(h) === 6 ? `[${h}]` : h}:${Number(port)}`;
}

/** Inverse of formatHostPort; also accepts a bare IPv6 literal followed by `:port` (legacy keys). */
export function parseHostPort(key: string): { host: string; port: number } | null {
    const s = String(key).trim();
    if (s.startsWith("[")) {
        const end = s.indexOf("]");
        if (end < 0 || s[end + 1] !== ":") return null;
        const port = Number(s.slice(end + 2));
        return validPort(port) ? { host: normalizeHost(s.slice(1, end)), port } : null;
    }
    const i = s.lastIndexOf(":");
    if (i <= 0) return null;
    const port = Number(s.slice(i + 1));
    if (!validPort(port)) return null;
    return { host: normalizeHost(s.slice(0, i)), port };
}

/** 16 network-order bytes of an IPv6 literal (handles `::`, embedded IPv4), or null. */
export function ipv6ToBytes(addr: string): Uint8Array | null {
    let s = String(addr).trim();
    if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
    const pct = s.indexOf("%");
    if (pct > 0) s = s.slice(0, pct);
    if (isIP(s) !== 6) return null;
    let tail: number[] = [];
    const lastColon = s.lastIndexOf(":");
    const last = s.slice(lastColon + 1);
    if (last.includes(".")) {
        if (isIP(last) !== 4) return null;
        const q = last.split(".").map(Number);
        tail = [(q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!];
        s = s.slice(0, lastColon + 1) + "0"; // placeholder hextet, replaced below
    }
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const parse = (p: string) => (p === "" ? [] : p.split(":").map((x) => parseInt(x, 16)));
    let words: number[];
    if (halves.length === 2) {
        const a = parse(halves[0]!), b = parse(halves[1]!);
        const fill = 8 - a.length - b.length - (tail.length ? 1 : 0);
        if (fill < 0) return null;
        words = [...a, ...new Array(fill).fill(0), ...b];
    } else words = parse(s);
    if (tail.length) words = [...words.slice(0, -1), ...tail];
    if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
    const out = new Uint8Array(16);
    words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 0xff; });
    return out;
}

/** RFC 5952 text of 16 network-order bytes (lowercase, longest zero run of ≥2 hextets as `::`). */
export function ipv6FromBytes(b: Uint8Array): string {
    const w: number[] = [];
    for (let i = 0; i < 8; i++) w.push((b[2 * i]! << 8) | b[2 * i + 1]!);
    let bestStart = -1, bestLen = 0;
    for (let i = 0; i < 8;) {
        if (w[i] !== 0) { i++; continue; }
        let j = i; while (j < 8 && w[j] === 0) j++;
        if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
        i = j;
    }
    const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
    if (bestStart < 0) return hex(w);
    return `${hex(w.slice(0, bestStart))}::${hex(w.slice(bestStart + bestLen))}`;
}

/**
 * Ledger (pool certificate) IPv6 bytes: four Word32 each written little-endian
 * (cardano-ledger-binary `ipv6ToBytes` = `putWord32le` of `fromIPv6w`). Verified on preview:
 * the relay registered as 2001:861:4000:2b80:216:3eff:fe05:9009 (cardano-cli ledger-peer-snapshot)
 * is stored on chain as 61 08 01 20 80 2b 00 40 ….
 */
export function ipv6FromLedgerBytes(b: Uint8Array): string | null {
    if (!(b instanceof Uint8Array) || b.length !== 16) return null;
    const net = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) { net[i] = b[i + 3]!; net[i + 1] = b[i + 2]!; net[i + 2] = b[i + 1]!; net[i + 3] = b[i]!; }
    return ipv6FromBytes(net);
}

export function ipv6ToLedgerBytes(addr: string): Uint8Array | null {
    const net = ipv6ToBytes(addr);
    if (!net) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) { out[i] = net[i + 3]!; out[i + 1] = net[i + 2]!; out[i + 2] = net[i + 1]!; out[i + 3] = net[i]!; }
    return out;
}

/**
 * PeerSharing / SockAddrInet6 words: network-socket's HostAddress6 is four host-order Word32
 * holding the address big-endian (0x20010db8 for 2001:db8::); ouroboros-network encodes them
 * as `[1, w1, w2, w3, w4, port]` (NodeToNode ≥ v13).
 */
export function ipv6ToWords(addr: string): [number, number, number, number] | null {
    const b = ipv6ToBytes(addr);
    if (!b) return null;
    const w = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    return [w(0), w(4), w(8), w(12)];
}

export function ipv6FromWords(words: ArrayLike<number | bigint>): string | null {
    if (!words || words.length < 4) return null;
    const b = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
        const n = Number(words[i]);
        if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
        b[4 * i] = (n >>> 24) & 0xff; b[4 * i + 1] = (n >>> 16) & 0xff; b[4 * i + 2] = (n >>> 8) & 0xff; b[4 * i + 3] = n & 0xff;
    }
    return ipv6FromBytes(b);
}

/** ouroboros-network `isValidDestinationIPAddr`: 0.0.0.0 and :: are not destinations. */
export function isValidDestination(host: string): boolean {
    const h = normalizeHost(host);
    const f = isIP(h);
    if (f === 4) return h !== "0.0.0.0";
    if (f === 6) return h !== "::";
    return h.length > 0;
}

function stripTrailingDot(d: string): string {
    const s = String(d).trim();
    return s.endsWith(".") ? s.slice(0, -1) : s;
}

/**
 * `FromJSON RelayAccessPoint` (topology) / `LedgerRelayAccessPoint` (snapshot): `address` (or the
 * older snapshot key `domain`) + optional `port`. No port = SRV domain. Returns null when unusable
 * (bad port; 0.0.0.0 / :: unless `allowInvalidDestination`, the ledger case).
 */
export function accessPointFromJson(o: unknown, opts: { allowInvalidDestination?: boolean } = {}): RelayAccessPoint | null {
    if (!o || typeof o !== "object") return null;
    const j = o as Record<string, unknown>;
    const raw = typeof j.address === "string" ? j.address : typeof j.domain === "string" ? j.domain : null;
    if (raw == null || !raw.trim()) return null;
    if (j.port === undefined || j.port === null) return { kind: "srv", host: stripTrailingDot(raw) };
    const port = Number(j.port);
    if (!validPort(port)) return null;
    const h = normalizeHost(raw);
    // Topology files reject 0.0.0.0 / :: (RelayAccessPoint FromJSON); ledger relays keep them
    // (LedgerRelayAccessPoint does not check): they hold stake on the selection axis, and the
    // dialer drops them (connecting to 0.0.0.0 would reach this very host).
    if (isIP(h)) return opts.allowInvalidDestination || isValidDestination(h) ? { kind: "address", host: h, port } : null;
    return { kind: "domain", host: stripTrailingDot(raw), port };
}

/** Apply the CIP-0155 SRV prefix to a ledger SRV relay (`prefixLedgerRelayAccessPoint`). */
export function prefixSrv(domain: string, prefix = CARDANO_SRV_PREFIX): string {
    const d = stripTrailingDot(domain);
    return prefix ? `${prefix}.${d}` : d;
}

/** Stable identity for dedupe (case-insensitive DNS names). */
export function accessPointKey(ap: RelayAccessPoint): string {
    if (ap.kind === "srv") return `srv:${ap.host.toLowerCase()}`;
    return `${ap.kind}:${formatHostPort(ap.kind === "domain" ? ap.host.toLowerCase() : ap.host, ap.port)}`;
}

export function accessPointLabel(ap: RelayAccessPoint): string {
    return ap.kind === "srv" ? `SRV ${ap.host}` : formatHostPort(ap.host, ap.port);
}
