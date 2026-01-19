import { fetch } from "bun";
import { logger } from "./logger";

export async function blockFrostFetchEra(epoch: number): Promise<string> {
    const BLOCKFROST_API_URL_PREPROD = `https://blockfrost-preprod.onchainapps.io/epochs/${epoch}/parameters`;
    const BLOCKFROST_API_URL_MAINNET = `https://blockfrost-mainnet.onchainapps.io/epochs/${epoch}/parameters`;

    let url = process.env.NETWORK === "mainnet"
        ? BLOCKFROST_API_URL_MAINNET
        : BLOCKFROST_API_URL_PREPROD;
        
    logger.debug(`Fetching epoch parameters for epoch ${epoch} from BlockFrost API at ${url}`);
    
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "project_id": process.env.BLOCKFROST_PROJECT_ID || "mainnetE56SZo3i2RwHTlmjlc6xzV66N8d7fAD8",
        },
    });

    if (!response.ok) {
        throw new Error(
            `Failed to fetch epoch parameters: ${response.status} ${response.statusText}`,
        );
    }
    const data: any = await response.json();
    return data.nonce;
};