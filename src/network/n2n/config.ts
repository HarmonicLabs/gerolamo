export interface N2NConfigInput {
    enabled?: boolean;
    host?: string;
    port?: number;
    maxConnections?: number;
    maxRangeBlocks?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
}

export interface ResolvedN2NConfig {
    enabled: true;
    host: string;
    port: number;
    maxConnections: number;
    maxRangeBlocks: number;
    handshakeTimeoutMs: number;
    idleTimeoutMs: number;
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
    };
}
