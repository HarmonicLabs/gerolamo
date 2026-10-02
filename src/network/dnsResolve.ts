/**
 * DNS for peer selection, following ouroboros-network `RootPeersDNS.DNSActions`:
 *
 * - a domain resolves to its A records, plus AAAA when this node can use IPv6
 *   (`DNSLookupType`: cardano-node asks only for the families it has an address in);
 * - an SRV name (`_cardano._tcp.<domain>` for ledger relays, CIP-0155) resolves as
 *   `srvRecordLookupWithTTL` does: drop "." targets, keep only the lowest priority, draw one
 *   target by weight (`randomR (0, Σweight)`, first cumulative weight ≥ the draw), then resolve
 *   that target with the SRV record's port. A failed target lookup is not retried on another one.
 *
 * Every lookup has a timeout (cardano-node's resolvTimeout is 3 s) and failures yield [] rather
 * than throwing: a dead relay must never stall the governor tick.
 */
import { promises as dnsp } from "node:dns";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { formatHostPort, normalizeHost, type RelayAccessPoint } from "./relayAccessPoint";

export interface SrvRecord { name: string; port: number; priority: number; weight: number }

export interface DnsBackend {
    resolve4(host: string): Promise<string[]>;
    resolve6(host: string): Promise<string[]>;
    resolveSrv(name: string): Promise<SrvRecord[]>;
}

export const systemDns: DnsBackend = {
    resolve4: (h) => dnsp.resolve4(h),
    resolve6: (h) => dnsp.resolve6(h),
    resolveSrv: (n) => dnsp.resolveSrv(n),
};

export const DEFAULT_DNS_TIMEOUT_MS = 4000;

export type Rng = () => number;

async function timed<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([p, new Promise<null>((r) => { t = setTimeout(() => r(null), ms); })]);
    } catch {
        return null;
    } finally {
        if (t) clearTimeout(t);
    }
}

export interface ResolveOptions {
    /** Also ask for AAAA records (default false: IPv4 only, as a node bound to 0.0.0.0). */
    ipv6?: boolean;
    timeoutMs?: number;
    backend?: DnsBackend;
    rng?: Rng;
}

/** A (+ AAAA) addresses of a domain, deduplicated, IPv4 first. Literal IPs come back as themselves. */
export async function resolveDomain(host: string, opts: ResolveOptions = {}): Promise<string[]> {
    const h = normalizeHost(host);
    if (!h) return [];
    if (isIP(h)) return [h];
    const be = opts.backend ?? systemDns;
    const ms = opts.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
    const [v4, v6] = await Promise.all([
        timed(be.resolve4(h), ms),
        opts.ipv6 ? timed(be.resolve6(h), ms) : Promise.resolve(null),
    ]);
    const out: string[] = [];
    for (const a of [...(v4 ?? []), ...(v6 ?? [])]) {
        const n = normalizeHost(a);
        if (isIP(n) === 4 || (opts.ipv6 && isIP(n) === 6)) if (!out.includes(n)) out.push(n);
    }
    return out;
}

/** The SRV target cardano-node would draw, or null (no usable record). Exported for tests. */
export function pickSrvTarget(records: SrvRecord[], rng: Rng = Math.random): SrvRecord | null {
    const usable = records.filter((r) => r && typeof r.name === "string" && r.name !== "" && r.name !== ".");
    if (usable.length === 0) return null;
    const top = Math.min(...usable.map((r) => r.priority));
    const group = usable.filter((r) => r.priority === top);
    if (group.length === 1) return group[0]!;
    // runWeightedLookup: cdf of cumulative weights, pick = randomR (0, upper) inclusive, lookupGE.
    let upper = 0;
    const cdf = group.map((r) => ({ upper: (upper += Math.max(0, r.weight)), r }));
    const pick = Math.floor(rng() * (upper + 1));
    return (cdf.find((c) => c.upper >= pick) ?? cdf[cdf.length - 1]!).r;
}

export async function resolveSrv(name: string, opts: ResolveOptions = {}): Promise<Array<{ host: string; port: number }>> {
    const be = opts.backend ?? systemDns;
    const records = await timed(be.resolveSrv(name), opts.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);
    if (!records?.length) return [];
    const target = pickSrvTarget(records, opts.rng);
    if (!target || !(target.port > 0 && target.port <= 65535)) return [];
    return (await resolveDomain(target.name, opts)).map((host) => ({ host, port: target.port }));
}

/** Addresses behind one access point (a literal passes through). */
export async function resolveAccessPoint(ap: RelayAccessPoint, opts: ResolveOptions = {}): Promise<Array<{ host: string; port: number }>> {
    if (ap.kind === "address") return [{ host: normalizeHost(ap.host), port: ap.port }];
    if (ap.kind === "domain") return (await resolveDomain(ap.host, opts)).map((host) => ({ host, port: ap.port }));
    return resolveSrv(ap.host, opts);
}

/** Dedupe host:port pairs (IPv6-safe). */
export function uniqueAddrs(addrs: Array<{ host: string; port: number }>): Array<{ host: string; port: number }> {
    const seen = new Set<string>();
    return addrs.filter((a) => { const k = formatHostPort(a.host, a.port); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Can this host reach IPv6 peers? True when some interface has a global unicast address
 * (2000::/3). Link-local, ULA and loopback do not count.
 */
export function hostHasGlobalIpv6(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
    for (const list of Object.values(ifaces)) {
        for (const i of list ?? []) {
            if (i.internal || (i.family as unknown) !== "IPv6" && (i.family as unknown) !== 6) continue;
            const first = parseInt(String(i.address).split(":")[0] || "0", 16);
            if ((first & 0xe000) === 0x2000) return true;
        }
    }
    return false;
}
