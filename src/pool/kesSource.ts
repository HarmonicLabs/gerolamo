/**
 * Where a block producer's hot credentials come from, checked before anything is loaded (and by
 * the config loader at startup): `kesSkeyFile` + `opcertFile`, or `kesAgentSocket` alone.
 * Light module: the config loader imports it without the producer's dependencies.
 */
import { validateKesAgentSocketPath } from "./kesAgent/client";

export type KesSource = "file" | "kes-agent";

/**
 * Where the hot credentials come from: `kesSkeyFile` + `opcertFile`, or `kesAgentSocket` alone.
 * Throws a configuration error naming the problem (checked before anything is loaded).
 */
export function kesSourceOf(cfg: { kesSkeyFile?: string; opcertFile?: string; kesAgentSocket?: string }): KesSource {
    const file = cfg.kesSkeyFile != null && cfg.kesSkeyFile !== "", agent = cfg.kesAgentSocket != null && cfg.kesAgentSocket !== "";
    if (file && agent) throw new Error("producer: kesSkeyFile and kesAgentSocket are mutually exclusive (the KES key comes either from a file or from a kes-agent)");
    if (!file && !agent) throw new Error("producer: set kesSkeyFile + opcertFile, or kesAgentSocket");
    if (agent) {
        // cardano-node's own invocation keeps --shelley-operational-certificate next to
        // --shelley-kes-agent-socket, so an opcertFile is tolerated here; the certificate used is
        // always the one the agent sends with the key.
        validateKesAgentSocketPath(cfg.kesAgentSocket!);
        return "kes-agent";
    }
    if (!cfg.opcertFile) throw new Error("producer: opcertFile is required with kesSkeyFile");
    return "file";
}
