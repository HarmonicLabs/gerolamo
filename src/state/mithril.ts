import { Cbor } from "@harmoniclabs/cbor";
import { join } from "node:path";

import { sql } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:url";

export async function loadLedgerStateFromAncilliary(ledgerPath: string) {
    console.log("Loading ledger state from ancillary files...");
    // Find the latest ledger snapshot
    const ledgerDirs = await readdir(ledgerPath);
    if (ledgerDirs.length === 0) {
        console.log("No ledger directories found");
        return;
    }

    // Use the latest (highest slot number) ledger directory
    const latestLedgerDir = Math.max(...ledgerDirs.flatMap((dir) => {
        const ret = parseInt(dir);
        return isNaN(ret) ? [] : ret;
    }));
    const latestLedgerDirPath = resolve(ledgerPath, latestLedgerDir.toString());
    console.log(`Using ledger snapshot from slot ${latestLedgerDir}: ${latestLedgerDirPath}`);

    // Read the ledger state files
    const stateFile = Bun.file(join(latestLedgerDirPath, 'state'));
    const metaFile = Bun.file(join(latestLedgerDirPath, 'meta'));
    const tvarFile = Bun.file(join(latestLedgerDirPath, 'tables', 'tvar'));

    console.log("Reading ledger state files...");
    const [stateData, metaData, tvarData] = await Promise.all([
        stateFile.exists().then(async (v) => {
            return v ? (await stateFile.arrayBuffer()) : undefined;
        }),
        metaFile.exists().then(async (v) => {
            return v ? (await metaFile.arrayBuffer()) : undefined;
        }),
        tvarFile.exists().then(async (v) => {
            return v ? (await tvarFile.arrayBuffer()) : undefined;
        })
    ]);

    if (!stateData) {
        throw new Error("Could not read state file");
    }

    console.log(`State file size: ${stateData?.byteLength} bytes`);
    console.log(`Meta file size: ${metaData?.byteLength || 0} bytes`);
    console.log(`TVAR file size: ${tvarData?.byteLength || 0} bytes`);

    // Try to decode the state file as CBOR
    const decodedState = Cbor.parse(new Uint8Array(stateData));
    console.log("Decoded state file structure:", typeof decodedState);

    if (typeof decodedState === 'object' && decodedState !== null) {
        console.log("State object keys:", Object.keys(decodedState));

        // Try to extract ledger components
        await processLedgerState(decodedState);
    }
}

async function processLedgerState(stateData: any) {
    console.log("Processing ledger state...");

    let utxoCount = 0;
    let stakeCount = 0;
    let delegationCount = 0;

    try {
        // Try to extract UTxO set
        if (stateData.utxo || stateData.utxos) {
            const utxoSet = stateData.utxo || stateData.utxos;
            console.log(`Found UTxO set with ${Object.keys(utxoSet).length} entries`);
            utxoCount = Math.min(Object.keys(utxoSet).length, 10); // Just count for now
        }

        // Try to extract stake distribution
        if (stateData.stake || stateData.stakes) {
            const stakeSet = stateData.stake || stateData.stakes;
            console.log(`Found stake distribution with ${Object.keys(stakeSet).length} entries`);
            stakeCount = Math.min(Object.keys(stakeSet).length, 10); // Just count for now
        }

        // Try to extract delegations
        if (stateData.delegations || stateData.delegs) {
            const delegationSet = stateData.delegations || stateData.delegs;
            console.log(`Found delegations with ${Object.keys(delegationSet).length} entries`);
            delegationCount = Math.min(Object.keys(delegationSet).length, 10); // Just count for now
        }

    } catch (error) {
        console.error("Error processing ledger state:", error);
    }

    console.log(`Ledger state processing summary:`);
    console.log(`- UTxO entries processed: ${utxoCount}`);
    console.log(`- Stake entries processed: ${stakeCount}`);
    console.log(`- Delegation entries processed: ${delegationCount}`);
}

// Type guards and processing functions
function isUtxoEntry(data: any): data is UtxoEntry {
    // Look for UTxO-like structure: transaction hash, output index, address, amount
    return data && typeof data === 'object' &&
           ((data.tx_hash && data.tx_index !== undefined) ||
            (data.txHash && data.outputIndex !== undefined)) &&
           (data.address || data.addr) &&
           (data.amount || data.value);
}

function isStakeEntry(data: any): data is StakeEntry {
    // Look for stake-like structure: stake key/credential and amount
    return data && typeof data === 'object' &&
           ((data.stake_key || data.stake_credential || data.credential) &&
            (data.amount !== undefined || data.value !== undefined));
}

function isDelegationEntry(data: any): data is DelegationEntry {
    // Look for delegation-like structure: stake key and pool ID
    return data && typeof data === 'object' &&
           ((data.stake_key || data.stake_credential) &&
            (data.pool_id || data.pool_hash || data.pool));
}

// Data types (flexible to handle different field names)
interface UtxoEntry {
    txHash?: string;
    tx_hash?: string;
    outputIndex?: number;
    tx_index?: number;
    address?: string;
    addr?: string;
    amount?: any;
    value?: any;
}

interface StakeEntry {
    stakeKey?: string;
    stake_key?: string;
    stake_credential?: string;
    credential?: string;
    amount?: any;
    value?: any;
}

interface DelegationEntry {
    stakeKey?: string;
    stake_key?: string;
    stake_credential?: string;
    poolId?: string;
    pool_id?: string;
    pool_hash?: string;
    pool?: string;
}

// Processing functions that load data into SQL database
async function processUtxoEntry(entry: UtxoEntry) {
    try {
        // Extract fields with fallbacks
        const txHash = entry.txHash || entry.tx_hash;
        const outputIndex = entry.outputIndex ?? entry.tx_index;
        const address = entry.address || entry.addr;
        const amount = entry.amount || entry.value;

        if (!txHash || outputIndex === undefined || !address || !amount) {
            console.log("Skipping incomplete UTxO entry:", entry);
            return;
        }

        // Generate UTxO reference
        const utxoRef = `${txHash}:${outputIndex}`;

        // Convert amount to JSON format expected by database
        let lovelace = "0";
        let assets = {};

        if (typeof amount === 'object') {
            lovelace = (amount.lovelace || amount.coin || amount.value || 0).toString();
            assets = amount.assets || amount.multiasset || {};
        } else if (typeof amount === 'number' || typeof amount === 'bigint') {
            lovelace = amount.toString();
        }

        const txOut = {
            address,
            amount: lovelace,
            assets,
        };

        console.log(`Processing UTxO: ${utxoRef}`);

        // Insert into utxo table
        await sql`INSERT OR IGNORE INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (${utxoRef}, ${JSON.stringify(txOut)}, ${txHash})`;
    } catch (error) {
        console.error("Error processing UTxO entry:", error, entry);
    }
}

async function processStakeEntry(entry: StakeEntry) {
    try {
        const stakeKey = entry.stakeKey || entry.stake_key || entry.stake_credential || entry.credential;
        const amount = entry.amount ?? entry.value;

        if (!stakeKey || amount === undefined) {
            console.log("Skipping incomplete stake entry:", entry);
            return;
        }

        console.log(`Processing stake: ${stakeKey}, amount: ${amount}`);

        // Insert into stake table
        await sql`INSERT OR REPLACE INTO stake (stake_credentials, amount) VALUES (${stakeKey}, ${amount})`;
    } catch (error) {
        console.error("Error processing stake entry:", error, entry);
    }
}

async function processDelegationEntry(entry: DelegationEntry) {
    try {
        const stakeKey = entry.stakeKey || entry.stake_key || entry.stake_credential;
        const poolId = entry.poolId || entry.pool_id || entry.pool_hash || entry.pool;

        if (!stakeKey || !poolId) {
            console.log("Skipping incomplete delegation entry:", entry);
            return;
        }

        console.log(`Processing delegation: ${stakeKey} -> ${poolId}`);

        // Insert into delegations table
        await sql`INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash) VALUES (${stakeKey}, ${poolId})`;
    } catch (error) {
        console.error("Error processing delegation entry:", error, entry);
    }
}
