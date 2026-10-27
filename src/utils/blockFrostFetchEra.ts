import { settings } from "../config/settings";
import { fetch } from "bun";
import { logger } from "./logger";
import { GerolamoConfig } from "../network/peerManager";

/**
 * Mirror without auth for the network, or "" when none exists: preview has no
 * mirror, and preprod's values must never stand in for it (its epoch nonces and
 * parameters differ).
 */
export function defaultOnchainappsBase(network?: string, networkMagic?: number): string {
    if (network === "mainnet" || networkMagic === 764824073) return "https://blockfrost-mainnet.onchainapps.io";
    if (network === "preview" || networkMagic === 2) return "";
    return "https://blockfrost-preprod.onchainapps.io";
}

/**
 * Fetch epoch nonce (and params) for header VRF validation.
 *
 * Official Blockfrost needs a real project_id. Onchainapps mirrors work without
 * auth. Never send a hardcoded mainnet token against preprod.
 * Order: config/env URL → onchainapps fallback.
 */
/**
 * Fetch the full Blockfrost-shaped `/epochs/{epoch}/parameters` record.
 * Order: config/env URL → onchainapps fallback.
 */
export async function blockFrostFetchEpochParams(
    configOrBaseUrl: GerolamoConfig | string,
    epoch: number,
): Promise<Record<string, unknown>> {
    const network =
        typeof configOrBaseUrl === "string"
            ? undefined
            : configOrBaseUrl.network;
    const magic = typeof configOrBaseUrl === "string" ? undefined : Number(configOrBaseUrl.networkMagic);
    const primary =
        typeof configOrBaseUrl === "string"
            ? configOrBaseUrl
            : configOrBaseUrl.blockfrostUrl?.trim() ||
              defaultOnchainappsBase(configOrBaseUrl.network, magic);

    const bases = [primary, defaultOnchainappsBase(network, magic)].filter(
        (u, i, arr) => Boolean(u) && arr.indexOf(u) === i,
    );
    if (bases.length === 0) {
        throw new Error(
            `No external epoch source for network ${network ?? "?"} (magic ${magic ?? "?"}): set blockfrostUrl or sync from genesis`,
        );
    }

    const projectId = settings().blockfrostProjectId?.trim();
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (projectId) headers.project_id = projectId;

    let lastErr: Error | undefined;
    for (const baseUrl of bases) {
        const url = `${baseUrl.replace(/\/$/, "")}/epochs/${epoch}/parameters`;
        logger.debug(
            `Fetching epoch parameters for epoch ${epoch} from ${url}`,
        );
        try {
            const response = await fetch(url, { method: "GET", headers });
            if (!response.ok) {
                lastErr = new Error(
                    `Failed to fetch epoch parameters from ${url}: ${response.status} ${response.statusText}`,
                );
                logger.warn(lastErr.message);
                continue;
            }
            const data = await response.json();
            if (!data || typeof data !== "object" || Array.isArray(data)) {
                lastErr = new Error(`Malformed epoch ${epoch} parameters from ${url}`);
                logger.warn(lastErr.message);
                continue;
            }
            return data as Record<string, unknown>;
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            logger.warn(`Epoch parameters fetch error for ${url}:`, lastErr.message);
        }
    }

    throw lastErr ?? new Error(`Failed to fetch epoch ${epoch} parameters from all sources`);
}

/** Epoch η0 nonce (hex) from the epoch parameters record. */
export async function blockFrostFetchEra(
    configOrBaseUrl: GerolamoConfig | string,
    epoch: number,
): Promise<string> {
    const data = await blockFrostFetchEpochParams(configOrBaseUrl, epoch);
    const nonce = data.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) {
        throw new Error(`No nonce field in epoch ${epoch} parameters`);
    }
    return nonce;
}
