import { settings } from "../../config/settings";
/**
 * cardano-node's `ExperimentalHardForksEnabled` (bug 421): with it off, Conway's successor is
 * `TriggerHardForkNotDuringThisExecution` and the node never enters Dijkstra; with it on, the
 * Dijkstra era (protocol 12) is reachable like any other era.
 *
 * Gerolamo keeps every Dijkstra code path behind this switch, so nothing changes for
 * Byron..Conway unless a network is configured for Dijkstra. Sources, any of:
 *   - the node configuration (`ExperimentalHardForksEnabled: true`, cardano-node's key, also
 *     read from the cardano-node config file next to the genesis files);
 *   - the flag `--experimental-hard-forks` (src/config/settings.ts; workers get it with the settings message).
 * Validation workers also get it from their job config (`applyExperimentalFromConfig`).
 */
let override: boolean | null = null;

export function experimentalHardForksEnabled(): boolean {
    return override ?? settings().experimentalHardForks === true;
}

export function setExperimentalHardForks(on: boolean): void {
    override = on;
}

/** True for the cardano-node key or Gerolamo's camelCase spelling of it. */
export function configEnablesExperimentalHardForks(cfg: Record<string, unknown> | null | undefined): boolean {
    if (!cfg) return false;
    const v = cfg.ExperimentalHardForksEnabled ?? cfg.experimentalHardForksEnabled;
    return v === true || v === "true" || v === 1;
}

/** Turn the switch on when a configuration asks for it (never turns it off). */
export function applyExperimentalFromConfig(cfg: Record<string, unknown> | null | undefined): void {
    if (configEnablesExperimentalHardForks(cfg) && !experimentalHardForksEnabled()) setExperimentalHardForks(true);
}

/** HFC index of the last era this execution can reach: Conway (6), or Dijkstra (7) with the switch on. */
export function lastReachableEra(): number {
    return experimentalHardForksEnabled() ? 7 : 6;
}

/** Ledger era tag of Dijkstra blocks (`[8, block]`), HFC index 7. */
export const DIJKSTRA_LEDGER_ERA = 8;
export const DIJKSTRA_HFC_ERA = 7;
/** `eraProtVerLow` of Dijkstra. */
export const DIJKSTRA_PROTOCOL_MAJOR = 12;
