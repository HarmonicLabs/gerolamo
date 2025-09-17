import { fetch } from "bun";

export async function blockFrostFetchEra(epoch: number): Promise<any> {
    const url =
        `https://blockfrost-preprod.onchainapps.io/epochs/${epoch}/parameters`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(
            `Failed to fetch epoch parameters: ${response.status} ${response.statusText}`,
        );
    }
    return await response.json();
}