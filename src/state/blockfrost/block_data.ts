import { BlockFrostAPI } from "@blockfrost/blockfrost-js";

export async function fetchBlockData(api: BlockFrostAPI, blockHash: string) {
    console.log(`Fetching block ${blockHash}...`);
    const block = await api.blocks(blockHash);
    console.log(`Block slot: ${block.slot}, height: ${block.height}`);

    // Calculate current epoch from slot (preprod epoch length is 432000 slots)
    const currentEpoch = Math.floor((block.slot || 0) / 432000);
    console.log(`Current epoch: ${currentEpoch}`);

    return { block, currentEpoch };
}

export async function fetchAddresses(api: BlockFrostAPI, blockHash: string) {
    console.log("Fetching addresses affected by block...");
    const addresses = await api.blocksAddressesAll(blockHash);
    console.log(`Found ${addresses.length} addresses affected by block`);
    return addresses;
}