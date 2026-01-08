// Using raw fetch instead of BlockFrostAPI for custom backend compatibility
import { sql } from "bun";

export async function populateUTxOs(
    apiConfig: any,
    stakeDistribution: { stake_address: string }[],
) {
    const baseUrl = apiConfig.customBackend || "https://blockfrost-preprod.onchainapps.io";

    console.log("Fetching complete UTxO set...");

    const uniqueStakeAddrs = Array.from(
        new Set(stakeDistribution.map((stake) => stake.stake_address)),
    );

    console.log(
        `Pulling data from ${uniqueStakeAddrs.length} unique stake addresses`,
    );

    console.log(`Processing ${uniqueStakeAddrs.length} stake addresses...`);

    // For efficiency, let's limit to first 1000 stake addresses for initial testing
    const limitedStakeAddrs = uniqueStakeAddrs.slice(0, 1000);
    console.log(`Limited to ${limitedStakeAddrs.length} stake addresses for testing`);

    const accountAddrs = await Promise.all(
        limitedStakeAddrs.map(async (stakeAddr, index) => {
            if (index % 100 === 0) {
                console.log(
                    `Processed ${index}/${limitedStakeAddrs.length} stake addresses`,
                );
            }
            try {
                const response = await fetch(`${baseUrl}/accounts/${stakeAddr}/addresses`);
                if (!response.ok) {
                    console.warn(`Failed to get addresses for stake ${stakeAddr}: ${response.status}`);
                    return [];
                }
                return await response.json();
            } catch (error) {
                console.warn(
                    `Failed to get addresses for stake ${stakeAddr}:`,
                    error,
                );
                return [];
            }
        }),
    );

    const flatAccountAddrs = accountAddrs.flat();
    console.log(
        `Pulling data from ${flatAccountAddrs.length} associated account addresses`,
    );

    console.log(`Fetching UTxOs from ${flatAccountAddrs.length} addresses...`);
    const utxos = await Promise.all(
        flatAccountAddrs.map(async (addr, index) => {
            if (index % 100 === 0) {
                console.log(
                    `Fetched UTxOs for ${index}/${flatAccountAddrs.length} addresses`,
                );
            }
            try {
                const response = await fetch(`${baseUrl}/addresses/${addr.address}/utxos`);
                if (!response.ok) {
                    console.warn(`Failed to get UTxOs for address ${addr.address}: ${response.status}`);
                    return [];
                }
                return await response.json();
            } catch (error) {
                console.warn(
                    `Failed to get UTxOs for address ${addr.address}:`,
                    error,
                );
                return [];
            }
        }),
    ).then((utxoArrays) => utxoArrays.flat());

    console.log(`Found ${utxos.length} UTxOs`);

    if (utxos.length === 0) {
        console.log("No UTxOs found, skipping insertion");
        return;
    }

    await sql`INSERT OR IGNORE INTO utxo ${
        sql(
            utxos.map((utxo) => {
                return {
                    utxo_ref: `${utxo.tx_hash}:${utxo.output_index}`,
                    tx_out: JSON.stringify({
                        address: utxo.address,
                        amount: utxo.amount.find((a) =>
                            a.unit === "lovelace"
                        )?.quantity || "0",
                    }),
                };
            }),
        )
    }`;
}
