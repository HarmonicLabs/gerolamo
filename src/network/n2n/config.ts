export interface N2NConfigInput {
    enabled?: boolean;
    host?: string;
    port?: number;
    maxConnections?: number;
    maxRangeBlocks?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    /** The address peers dial us at (the registered relay, e.g. "63.45.33.80:3001"); self-probed every 2 min. */
    publicAddress?: string;
    /** N2N over WebSocket for browser nodes (docs/PLAN_BROWSER_NODE.md): same protocols, second bearer. */
    ws?: { enabled?: boolean; host?: string; port?: number };
}

export interface ResolvedN2NConfig {
    enabled: true;
    host: string;
    port: number;
    maxConnections: number;
    maxRangeBlocks: number;
    handshakeTimeoutMs: number;
    idleTimeoutMs: number;
    publicAddress?: string;
    /** WebSocket bearer, when enabled (`n2n.ws.enabled`, --n2n-ws or --n2n-ws-port). */
    ws?: { host: string; port: number };
}

/** The inbound N2N listener from config (the resolved settings are already merged in by loadConfig); undefined when off. */
export function resolveN2NConfig(input: N2NConfigInput | undefined): ResolvedN2NConfig | undefined {
    if (input?.enabled !== true) return undefined;
    const port = Number(input.port ?? 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid inbound N2N port: ${String(port)}`);
    }

    const positiveInt = (value: unknown, fallback: number): number => {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : fallback;
    };

    return {
        enabled: true,
        host: input.host?.trim() || "0.0.0.0",
        port,
        maxConnections: positiveInt(input.maxConnections, 64),
        maxRangeBlocks: positiveInt(input.maxRangeBlocks, 256),
        handshakeTimeoutMs: positiveInt(input.handshakeTimeoutMs, 10_000),
        idleTimeoutMs: positiveInt(input.idleTimeoutMs, 120_000),
        publicAddress: typeof input.publicAddress === "string" && input.publicAddress.trim() ? input.publicAddress.trim() : undefined,
        ws: resolveWs(input.ws),
    };
}

function resolveWs(input: N2NConfigInput["ws"]): { host: string; port: number } | undefined {
    if (input?.enabled !== true) return undefined;
    const port = Number(input.port ?? 3002);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid N2N WebSocket port: ${String(port)}`);
    return { host: input.host?.trim() || "0.0.0.0", port };
}
