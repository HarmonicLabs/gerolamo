/**
 * Process-wide event counters for the Prometheus endpoint, named after the cardano-node trace
 * metrics they mirror (Consensus.hs / ForgingStats.hs / NodeToNode.hs in cardano-node's tracers):
 *
 *   served.block       BlockFetch server: blocks sent (inbound and duplex connections)
 *   served.header      ChainSync server: headers (roll-forwards) sent
 *   Forge.*            forge loop outcomes (node-is-leader, forged, adopted, didnt-adopt, …)
 *
 * Counters only go up; the exposition layer turns them into `cardano_node_metrics_*_counter`.
 */
export type ForgeEvent =
    | "node-is-leader" | "node-not-leader" | "forged" | "adopted" | "didnt-adopt" | "forged-invalid"
    | "could-not-forge" | "about-to-lead" | "slot-is-immutable" | "block-from-future";

const counters = new Map<string, number>();
let forgedSlotLast: bigint | null = null;

function bump(name: string, by = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + by);
}

export function noteServed(kind: "block" | "header", n = 1): void {
    bump(`served.${kind}`, n);
}

export function noteForgeEvent(ev: ForgeEvent, slot?: bigint): void {
    bump(`Forge.${ev}`);
    if (ev === "forged" && slot != null) forgedSlotLast = slot;
}

export function counterValue(name: string): number {
    return counters.get(name) ?? 0;
}

export function allCounters(): ReadonlyMap<string, number> {
    return counters;
}

export function lastForgedSlot(): bigint | null {
    return forgedSlotLast;
}

/** Tests only. */
export function resetNodeMetrics(): void {
    counters.clear();
    forgedSlotLast = null;
}
