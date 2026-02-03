import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { Database } from "bun:sqlite";

export async function populateUTxOs(
    db: Database,
    api: BlockFrostAPI,
    stakeDistribution: { stake_address: string }[],
) {
    console.log("Fetching complete UTxO set...");

    const uniqueStakeAddrs = Array.from(
        new Set(stakeDistribution.map((stake) => stake.stake_address)),
    );

    console.log(
        `Pulling data from ${uniqueStakeAddrs.length} unique stake addresses`,
    );

    console.log(`Processing ${uniqueStakeAddrs.length} stake addresses...`);

    const accountAddrs = await Promise.all(
        uniqueStakeAddrs.map(async (stakeAddr, index) => {
            if (index % 1000 === 0) {
                console.log(
                    `Processed ${index}/${uniqueStakeAddrs.length} stake addresses`,
                );
            }
            try {
                return await api.accountsAddressesAll(stakeAddr);
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
            if (index % 1000 === 0) {
                console.log(
                    `Fetched UTxOs for ${index}/${flatAccountAddrs.length} addresses`,
                );
            }
            try {
                return await api.addressesUtxosAll(addr.address);
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

    const stmt = db.prepare(`
        INSERT OR IGNORE INTO utxo (utxo_ref, tx_out, tx_hash)
        VALUES (?, ?, ?)
    `);
    for (const utxo of utxos) {
        const utxoRef = `${utxo.tx_hash}:${utxo.output_index}`;
        const txOut = JSON.stringify({
            address: utxo.address,
            amount: utxo.amount.find((a) => a.unit === "lovelace")?.quantity ||
                "0",
        });
        stmt.run(utxoRef, txOut, utxo.tx_hash);
    }
}
