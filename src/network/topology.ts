import { hasOwn, isObject } from "@harmoniclabs/obj-utils";
import { dirname, isAbsolute, join } from "node:path";
import { accessPointFromJson, type RelayAccessPoint } from "./relayAccessPoint";

export interface TopologyAccessPoint {
    address: string;
    port: number;
}

export interface TopologyRoot {
    accessPoints: TopologyAccessPoint[];
    advertise: boolean;
    valency?: number;
}

export interface Topology {
    localRoots: TopologyRoot[];
    publicRoots: TopologyRoot[];
    bootstrapPeers: TopologyAccessPoint[]; // Changed to match accessPoints structure
    useLedgerAfterSlot: number;
}
export interface LegacyAccessPoint {
    addr: string;
    port: number;
    valency: number;
}

export interface LegacyTopology {
    Producers: LegacyAccessPoint[];
}

export function isTopology(stuff: any): stuff is Topology {
    if (!isObject(stuff)) return false;
    if (isLegacyTopology(stuff)) return false;

    return (
        hasOwn(stuff, "localRoots") &&
        Array.isArray(stuff.localRoots) &&
        stuff.localRoots.every(isTopologyRoot) &&
        hasOwn(stuff, "publicRoots") &&
        Array.isArray(stuff.publicRoots) &&
        stuff.publicRoots.every(isTopologyRoot) &&
        hasOwn(stuff, "useLedgerAfterSlot") &&
        Number.isSafeInteger(stuff.useLedgerAfterSlot) &&
        stuff.useLedgerAfterSlot >= 0
    );
}

export function isTopologyRoot(stuff: any): stuff is TopologyRoot {
    if (!isObject(stuff)) return false;

    return (
        hasOwn(stuff, "accessPoints") &&
        Array.isArray(stuff.accessPoints) &&
        stuff.accessPoints.every(isTopologyAccessPoint) &&
        hasOwn(stuff, "advertise") &&
        typeof stuff.advertise === "boolean" &&
        (typeof stuff.valency === "undefined" ||
            (Number.isSafeInteger(stuff.valency) && stuff.valency >= 0))
    );
}

export function isTopologyAccessPoint(
    stuff: any,
): stuff is TopologyAccessPoint {
    if (!isObject(stuff)) return false;

    return (
        hasOwn(stuff, "address") &&
        typeof stuff.address === "string" &&
        hasOwn(stuff, "port") &&
        typeof stuff.port === "number"
    );
}

export function isLegacyTopology(stuff: any): stuff is LegacyTopology {
    if (!isObject(stuff)) return false;

    return (
        hasOwn(stuff, "Producers") &&
        Array.isArray(stuff.Producers) &&
        stuff.Producers.every(isLegacyAccessPoint)
    );
}

export function isLegacyAccessPoint(stuff: any): stuff is LegacyAccessPoint {
    if (!isObject(stuff)) return false;

    return (
        hasOwn(stuff, "addr") &&
        typeof stuff.addr === "string" &&
        hasOwn(stuff, "port") &&
        typeof stuff.port === "number" &&
        hasOwn(stuff, "valency") &&
        typeof stuff.valency === "number" &&
        stuff.valency >= 0
    );
}

export function adaptLegacyTopology(legacy: LegacyTopology): Topology {
    const topology: Topology = {
        localRoots: legacy.Producers.map(legacyAccessPointToTopologyRoot),
        publicRoots: [],
        bootstrapPeers: [],
        useLedgerAfterSlot: 0,
    };

    return topology;
}

export function legacyAccessPointToTopologyRoot(
    ap: LegacyAccessPoint,
): TopologyRoot {
    return {
        accessPoints: [
            {
                address: ap.addr,
                port: ap.port,
            },
        ],
        advertise: false,
        valency: ap.valency,
    };
}

// ─── cardano-node topology semantics ─────────────────────────────────────────
//
// ouroboros-network orphan instances (`networkTopologyFromJSON`, `localRootPeersGroupFromJSON`,
// `FromJSON RootConfig`, `FromJSON UseLedgerPeers`) + cardano-diffusion (`trustable`,
// `bootstrapPeers`) + cardano-node `readTopologyFile` (paths relative to the topology file).


export type DiffusionMode = "InitiatorOnly" | "InitiatorAndResponder";

export interface LocalRootGroup {
    accessPoints: RelayAccessPoint[];
    /** Share these peers over peer sharing (default false). */
    advertise: boolean;
    /** May be used while the ledger is too old / in bootstrap (default false). */
    trustable: boolean;
    /** Active (hot) connections to keep to this group: `valency` or `hotValency`. */
    hotValency: number;
    /** Established (warm + hot) connections to keep; defaults to hotValency. */
    warmValency: number;
    /** The peer connects to us (it is not dialled). */
    behindFirewall: boolean;
    diffusionMode: DiffusionMode;
}

export interface NormalizedTopology {
    localRoots: LocalRootGroup[];
    publicRoots: Array<{ accessPoints: RelayAccessPoint[]; advertise: boolean }>;
    /** null = DontUseBootstrapPeers (field absent or null). */
    bootstrapPeers: RelayAccessPoint[] | null;
    /** < 0 don't use ledger peers (absent / negative), 0 always, > 0 after this slot. */
    useLedgerAfterSlot: number;
    /** Big ledger peer snapshot, resolved against the topology file's directory. */
    peerSnapshotFile: string | null;
}

function aps(list: unknown, where: string, warnings: string[]): RelayAccessPoint[] {
    if (!Array.isArray(list)) throw new Error(`${where}.accessPoints must be an array`);
    const out: RelayAccessPoint[] = [];
    list.forEach((raw, i) => {
        const ap = accessPointFromJson(raw);
        if (ap) out.push(ap);
        else warnings.push(`${where}.accessPoints[${i}] ignored (needs "address" and a port 1–65535, or no port for an SRV name; 0.0.0.0 / :: are not destinations)`);
    });
    return out;
}

function count(v: unknown): number | null {
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Parse topology.json the way cardano-node does. Required: `localRoots` (array) and
 * `publicRoots` (array). Legacy `{"Producers": [...]}` files are adapted first. Unknown keys are
 * ignored. Throws on a malformed file (the node must not start on a half-read topology).
 */
export function normalizeTopology(json: unknown, topologyPath?: string): { topology: NormalizedTopology; warnings: string[] } {
    const warnings: string[] = [];
    let j: any = json;
    if (isLegacyTopology(j)) j = adaptLegacyTopology(j);
    if (!isObject(j)) throw new Error("topology must be a JSON object");
    if (!Array.isArray(j.localRoots)) throw new Error('topology: "localRoots" must be an array');
    if (!Array.isArray(j.publicRoots)) throw new Error('topology: "publicRoots" must be an array');
    const localRoots: LocalRootGroup[] = j.localRoots.map((g: any, i: number) => {
        if (!isObject(g)) throw new Error(`localRoots[${i}] must be an object`);
        const where = `localRoots[${i}]`;
        let hot = count((g as any).valency) ?? count((g as any).hotValency);
        if (hot == null) {
            // cardano-node rejects the file; earlier Gerolamo versions accepted it (no valency
            // enforcement), which running installations rely on: keep that, loudly.
            warnings.push(`${where} has neither "valency" nor "hotValency" (cardano-node refuses this file); no valency is enforced for the group`);
            hot = 0;
        }
        const warm = count((g as any).warmValency) ?? hot;
        const mode = (g as any).diffusionMode;
        if (mode !== undefined && mode !== "InitiatorOnly" && mode !== "InitiatorAndResponder") throw new Error(`${where}.diffusionMode must be "InitiatorOnly" or "InitiatorAndResponder"`);
        return {
            accessPoints: aps((g as any).accessPoints, where, warnings),
            advertise: (g as any).advertise === true,
            trustable: (g as any).trustable === true,
            hotValency: hot,
            warmValency: Math.max(hot, warm),
            behindFirewall: (g as any).behindFirewall === true,
            diffusionMode: mode ?? "InitiatorAndResponder",
        } satisfies LocalRootGroup;
    });
    const publicRoots = j.publicRoots.map((g: any, i: number) => {
        if (!isObject(g)) throw new Error(`publicRoots[${i}] must be an object`);
        return { accessPoints: aps((g as any).accessPoints, `publicRoots[${i}]`, warnings), advertise: (g as any).advertise === true };
    });
    let bootstrapPeers: RelayAccessPoint[] | null = null;
    if (Array.isArray(j.bootstrapPeers)) {
        bootstrapPeers = [];
        j.bootstrapPeers.forEach((raw: unknown, i: number) => {
            const ap = accessPointFromJson(raw);
            if (ap) bootstrapPeers!.push(ap);
            else warnings.push(`bootstrapPeers[${i}] ignored`);
        });
    } else if (j.bootstrapPeers !== undefined && j.bootstrapPeers !== null) throw new Error('topology: "bootstrapPeers" must be an array or null');
    let useLedgerAfterSlot = -1;
    if (j.useLedgerAfterSlot !== undefined) {
        const n = Number(j.useLedgerAfterSlot);
        if (typeof j.useLedgerAfterSlot !== "number" || !Number.isFinite(n)) throw new Error('topology: "useLedgerAfterSlot" must be a number');
        useLedgerAfterSlot = n < 0 ? -1 : Math.floor(n);
    }
    let peerSnapshotFile: string | null = null;
    if (typeof j.peerSnapshotFile === "string" && j.peerSnapshotFile.trim()) {
        const p = j.peerSnapshotFile.trim();
        peerSnapshotFile = isAbsolute(p) || !topologyPath ? p : join(dirname(topologyPath), p);
        if (useLedgerAfterSlot < 0) warnings.push("Peer snapshot file specified but topology disables ledger peers - ignoring file");
    }
    return { topology: { localRoots, publicRoots, bootstrapPeers, useLedgerAfterSlot, peerSnapshotFile }, warnings };
}
