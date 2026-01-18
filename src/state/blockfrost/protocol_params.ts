import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { Database } from "bun:sqlite";

export async function populateProtocolParams(db: Database, protocolParams: any) {
    db.run(
        `INSERT OR REPLACE INTO protocol_params (id, params) VALUES (?, ?)`,
        [1, JSON.stringify(protocolParams)]
    );
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
