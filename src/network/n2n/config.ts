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
    /** WebSocket bearer, when enabled (`n2n.ws.enabled` or GEROLAMO_N2N_WS_PORT). */
    ws?: { host: string; port: number };
}

export function resolveN2NConfig(
    input: N2NConfigInput | undefined,
    env: Record<string, string | undefined> = process.env,
): ResolvedN2NConfig | undefined {
    const switchValue = env.GEROLAMO_N2N?.trim().toLowerCase();
    if (switchValue === "0" || switchValue === "false") return undefined;

    const envPort = Number(env.GEROLAMO_N2N_PORT);
    const hasEnvPort = Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535;
    const enabled =
        hasEnvPort ||
        input?.enabled === true ||
        switchValue === "1" ||
        switchValue === "true";
    if (!enabled) return undefined;

    const configuredPort = Number(input?.port ?? 3001);
    const port = hasEnvPort ? envPort : configuredPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid inbound N2N port: ${String(port)}`);
    }

    const positiveInt = (value: unknown, fallback: number): number => {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : fallback;
    };

    return {
        enabled: true,
        host: env.GEROLAMO_N2N_HOST?.trim() || input?.host?.trim() || "0.0.0.0",
        port,
        maxConnections: positiveInt(input?.maxConnections, 64),
        maxRangeBlocks: positiveInt(input?.maxRangeBlocks, 256),
        handshakeTimeoutMs: positiveInt(input?.handshakeTimeoutMs, 10_000),
        idleTimeoutMs: positiveInt(input?.idleTimeoutMs, 120_000),
        publicAddress: typeof input?.publicAddress === "string" && input.publicAddress.trim() ? input.publicAddress.trim() : undefined,
        ws: resolveWs(input?.ws, env),
    };
}

function resolveWs(input: N2NConfigInput["ws"], env: Record<string, string | undefined>): { host: string; port: number } | undefined {
    const envPort = Number(env.GEROLAMO_N2N_WS_PORT);
    const hasEnvPort = Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535;
    if (!hasEnvPort && input?.enabled !== true) return undefined;
    const port = hasEnvPort ? envPort : Number(input?.port ?? 3002);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid N2N WebSocket port: ${String(port)}`);
    return { host: env.GEROLAMO_N2N_WS_HOST?.trim() || input?.host?.trim() || "0.0.0.0", port };
}
