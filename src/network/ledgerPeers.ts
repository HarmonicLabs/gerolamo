/**
 * Ledger peers: the relays every registered pool announces in its registration
 * certificate. cardano-node fills most of its known-peer set from them (stake-weighted
 * picks); a producer that never asks for peers over peer sharing (it must not advertise
 * itself) still needs them to keep 20 warm duplex connections to distinct relays, which
 * is what gets its blocks pulled (see PLAN_BLOCK_PRODUCTION.md, "Propagation odds").
 *
 * Sources: the `pool_relays` table (written at every registration certificate) and, for
 * pools registered before that table existed, `<node dir>/ledger-relays.json` generated
 * from a Mithril ledger snapshot by `scripts/ledger-relays.ts`.
 */
import { CborArray, CborBytes, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";

export interface LedgerRelay { pool: string; host: string; port: number }

const DEFAULT_PORT = 3001;

function portOf(o: CborObj | undefined): number {
    if (o instanceof CborUInt) { const n = Number(o.num); return n > 0 && n <= 65535 ? n : DEFAULT_PORT; }
    return DEFAULT_PORT;
}

/** Shelley relay CBOR: [0, port?, ipv4?, ipv6?] · [1, port?, dnsName] · [2, dnsName] (SRV, skipped). */
export function relayFromCbor(obj: CborObj): { host: string; port: number } | null {
    if (!(obj instanceof CborArray) || !(obj.array[0] instanceof CborUInt)) return null;
    const tag = Number(obj.array[0].num);
    if (tag === 0) {
        const v4 = obj.array[2];
        if (v4 instanceof CborBytes && v4.bytes.length === 4) return { host: Array.from(v4.bytes).join("."), port: portOf(obj.array[1]) };
        return null; // IPv6-only relays: our dialer is IPv4
    }
    if (tag === 1) {
        const name = obj.array[2];
        if (name instanceof CborText && name.text.trim()) return { host: name.text.trim(), port: portOf(obj.array[1]) };
        return null;
    }
    return null;
}

/** A cardano-ledger-ts PoolRelay object (registration certificates as the node applies them). */
export function relayFromLedgerTs(r: any): { host: string; port: number } | null {
    if (!r || typeof r !== "object") return null;
    const port = r.port != null && Number(r.port) > 0 && Number(r.port) <= 65535 ? Number(r.port) : DEFAULT_PORT;
    if (r.type === "ip") {
        const v4 = r.ipv4;
        if (v4 instanceof Uint8Array && v4.length === 4) return { host: Array.from(v4).join("."), port };
        if (typeof v4 === "string" && v4) return { host: v4, port };
        return null;
    }
    if (r.type === "dns" && typeof r.dnsName === "string" && r.dnsName.trim()) return { host: r.dnsName.trim(), port };
    return null;
}

/** Relays of every pool in a decoded ledger snapshot (`decodeLedgerSnapshot(...).pools`). */
export function ledgerRelaysFromSnapshotPools(pools: Map<string, { relays: CborObj[] }>): LedgerRelay[] {
    const out: LedgerRelay[] = [];
    for (const [pool, p] of pools) for (const r of p.relays ?? []) { const d = relayFromCbor(r); if (d) out.push({ pool, ...d }); }
    return out;
}

export interface LedgerRelaysFile { generatedAt: string; stateSlot: number | null; relays: LedgerRelay[] }

export async function loadLedgerRelaysFile(path: string): Promise<LedgerRelay[]> {
    try {
        const f = Bun.file(path);
        if (!(await f.exists())) return [];
        const j = (await f.json()) as LedgerRelaysFile;
        return Array.isArray(j?.relays) ? j.relays.filter((r) => r && typeof r.host === "string" && Number.isInteger(r.port)) : [];
    } catch { return []; }
}

/** Dedupe by host:port, keeping the first pool that announced it. */
export function dedupeRelays(relays: LedgerRelay[]): LedgerRelay[] {
    const seen = new Set<string>(); const out: LedgerRelay[] = [];
    for (const r of relays) { const k = `${r.host.toLowerCase()}:${r.port}`; if (seen.has(k)) continue; seen.add(k); out.push(r); }
    return out;
}
