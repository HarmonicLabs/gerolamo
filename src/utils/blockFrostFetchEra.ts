import { fetch } from "bun";
import { logger } from "./logger";
import { GerolamoConfig } from "../network/peerManager";

export async function blockFrostFetchEra(
    configOrBaseUrl: GerolamoConfig | string,
    epoch: number,
): Promise<string> {
    const baseUrl = typeof configOrBaseUrl === "string"
        ? configOrBaseUrl
        : configOrBaseUrl.blockfrostUrl ?? (
            configOrBaseUrl.network === "mainnet"
                ? "https://blockfrost-mainnet.onchainapps.io"
                : "https://blockfrost-preprod.onchainapps.io"
        );

    const url = `${baseUrl}/epochs/${epoch}/parameters`;

    logger.debug(
        `Fetching epoch parameters for epoch ${epoch} from BlockFrost API at ${url}`,
    );

    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "project_id": process.env.BLOCKFROST_PROJECT_ID ||
                "mainnetE56SZo3i2RwHTlmjlc6xzV66N8d7fAD8",
        },
    });

    if (!response.ok) {
        throw new Error(
            `Failed to fetch epoch parameters: ${response.status} ${response.statusText}`,
        );
    }
    const data: any = await response.json();
    return data.nonce;
}
