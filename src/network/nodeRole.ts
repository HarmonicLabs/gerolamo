import type { GerolamoConfig } from "./peerManager";

/**
 * Node role: what this process offers to the network.
 *
 * - "data"  (default): outbound-only. Follows the chain, serves MiniBF/N2C
 *   locally, accepts no inbound Cardano peers. Handshake advertises
 *   InitiatorOnly + PeerSharing disabled, as the network spec asks of nodes
 *   that are not reachable at the address they connect from (otherwise
 *   relays share our ephemeral address and other nodes waste time on it).
 * - "relay": also listens for inbound node-to-node connections (ChainSync,
 *   BlockFetch, KeepAlive) and advertises InitiatorAndResponder +
 *   PeerSharing enabled.
 * - "producer": a relay that also forges blocks with the keys in `producer`
 *   (block plan). Its relays pull the forged blocks over the inbound listener,
 *   so inbound N2N is on; PeerSharing stays off (a producer is not advertised).
 *
 * Config: top-level `role`. `n2n.enabled` / --n2n-port still turn the
 * listener on for a data node (legacy), and `peerGovernor.peerSharing` can
 * force the PeerSharing flag either way.
 */
export type NodeRole = "data" | "relay" | "producer";

type RoleConfig = Pick<GerolamoConfig, "role" | "n2n" | "peerGovernor">;

export function resolveNodeRole(config: Partial<RoleConfig> | undefined): NodeRole {
    const r = String(config?.role ?? "").trim().toLowerCase();
    if (r === "relay") return "relay";
    if (r === "producer") return "producer";
    if (r === "data" || r === "") return config?.n2n ? "relay" : "data";
    return "data";
}

/** Inbound N2N listener wanted? Relay role, or legacy n2n.enabled. */
export function inboundEnabled(config: Partial<RoleConfig> | undefined): boolean {
    const role = resolveNodeRole(config);
    return role === "relay" || role === "producer";
}

/** Handshake flag: do we advertise PeerSharing (and thus run its client)? */
export function peerSharingAdvertised(config: Partial<RoleConfig> | undefined): boolean {
    const override = config?.peerGovernor?.peerSharing;
    if (typeof override === "boolean") return override;
    return resolveNodeRole(config) === "relay";
}

/** Handshake flag: InitiatorOnlyDiffusionMode (true for a data node). */
export function initiatorOnly(config: Partial<RoleConfig> | undefined): boolean {
    return resolveNodeRole(config) === "data";
}
