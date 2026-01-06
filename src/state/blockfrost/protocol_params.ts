import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { sql } from "bun";

export async function populateProtocolParams(protocolParams: any) {
    await sql`
        INSERT OR REPLACE INTO protocol_params (id, params)
        VALUES (1, json(${JSON.stringify(protocolParams)}))
    `;
}

export async function fetchProtocolParameters(
    api: BlockFrostAPI,
    epoch: number,
) {
    console.log("Fetching protocol parameters...");
    const protocolParams = await api.epochsParameters(epoch);
    console.log("Protocol parameters fetched");
    return protocolParams;
}
