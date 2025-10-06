import { open } from "lmdb";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../../utils/logger";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";

const rootDB = open({
    path: "./src/store/gerolamo.lmdb",
    maxDbs: 10,
    eventTurnBatching: true,
    strictAsyncOrder: true,
});

const epochRollingNonceDb = rootDB.openDB({ name: "epoch_rolling_nonce", encoding: "json" });
const epochNonceIndexDb = rootDB.openDB({ name: "epoch_nonce_index", encoding: "binary" });
const slotIndexDB = rootDB.openDB({ name: "slot_to_hash", encoding: "binary" });
const headersDB = rootDB.openDB({ name: "headers", encoding: "binary" });

const getEpochRollingNonce = (epoch: number, slot: number) => { 
    const rollingNonces = epochRollingNonceDb.get(epoch);
    logger.debug("data: ", rollingNonces);
    return rollingNonces;
}

const getEpochNonceTest = async (epoch: number) => { 
    // Check if the root database is open
    console.log("rootDB opened:", rootDB !== null && rootDB !== undefined);
    if (!rootDB) {
        console.error("Failed to open rootDB at ./src/store/gerolamo.lmdb");
        return;
    }

    // Check if the specific database is open
    console.log("epochNonceIndexDb opened:", epochNonceIndexDb !== null && epochNonceIndexDb !== undefined);
    if (!epochNonceIndexDb) {
        console.error("Failed to open epoch_nonce_index database");
        return;
    }

    // Test database accessibility by attempting to read
    try {
        console.log("Database is accessible");
    } catch (error) {
        console.error("Database access error:", error);
    }

    // Attempt to retrieve a value to confirm accessibility
    const epochNonce = epochNonceIndexDb.get(epoch);
    console.log(`epochNonce for ${epoch}: `, toHex(epochNonce));
    // Optional: Iterate over all keys to inspect contents
    for (const key of epochNonceIndexDb.getKeys()) {
        const value = epochNonceIndexDb.get(key);
        console.log(`Key: ${String(key)}, Value: ${value}`);
    }
    // rootDB.close();
};

const getEpochHeaders = async (epoch: number) => { 
    const epochHeadersRes = headersDB.get(epoch);
    console.log("epoch: ", epoch, " headers: ", epochHeadersRes)

}

const putEpochNonceTest = async (epoch: number, nonce: Uint8Array) => { 
    epochNonceIndexDb.put(epoch, nonce);
    console.log(`Inserted nonce for epoch ${epoch}`);
    // rootDB.close();
}

putEpochNonceTest(11, fromHex("ebbe238f13c6512ca303ad234f028185f04621694428bf4036e827529fb8fd0c")).catch(err => {
     console.error("Error in putEpochNonceTest:", err);
});

getEpochNonceTest(11).catch(err => {
    console.error("Error in getEpochNonceTest:", err);
});

// getEpochHeaders(13);

// getEpochRollingNonce(13, 3974417);