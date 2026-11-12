import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { sql } from "../../sql";

export async function populateProtocolParams(
    protocolParams: any,
) {
    await sql`INSERT OR REPLACE INTO protocol_params (id, params) VALUES (${1}, ${JSON.stringify(protocolParams)})`;
}

export async function fetchProtocolParameters(
    api: BlockfrostPluts,
    epoch: number,
) {
    console.log("Fetching protocol parameters...");
    const protocolParams = await api.epochsParametersRaw(epoch);
    console.log("Protocol parameters fetched");
    return protocolParams;
}
