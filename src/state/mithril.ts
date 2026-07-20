import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { resolve } from "node:url";

import { sql } from "../sql";

/**
 * Ancillary ledger loader (Mithril Cardano DB snapshot).
 *
 * A2 BLOCKER (2026-07-17, local preprod snapshot):
 * - `state` is CborArray(2) NewEpochState-shaped, not JSON maps with `.utxo` keys.
 * - Nested indefinite CborMaps + `SubCborRef` deferred blobs; map entries not
 *   iterable via simple Object.keys / Map.entries after `@harmoniclabs/cbor` parse.
 * - Full unwrap of ~800MB `tables/tvar` OOMs in Bun.
 * - No TxIn-keyed UTxO pair-list found in walkable state (largest hit was
 *   unrelated pair-list keys all `n1`).
 *
 * Density path today: immutable chunks via `processChunk` / `read-raw-chunks`
 * (Path 1). Do not claim ancillary UTxO hydrate until a streaming/deferred
 * CBOR reader lands. Stock mithril-client is still correct for file download —
 * the gap is adapter, not client.
 */
export async function loadLedgerStateFromAncilliary(ledgerPath: string) {
    console.log("Loading ledger state from ancillary files...");
    const ledgerDirs = await readdir(ledgerPath);
    if (ledgerDirs.length === 0) {
        console.log("No ledger directories found");
        return;
    }

    const latestLedgerDir = Math.max(...ledgerDirs.flatMap((dir) => {
        const ret = parseInt(dir);
        return isNaN(ret) ? [] : ret;
    }));
    const latestLedgerDirPath = resolve(ledgerPath, latestLedgerDir.toString());
    console.log(`Using ledger snapshot from slot ${latestLedgerDir}: ${latestLedgerDirPath}`);

    const stateFile = Bun.file(join(latestLedgerDirPath, "state"));
    const metaFile = Bun.file(join(latestLedgerDirPath, "meta"));
    const tvarFile = Bun.file(join(latestLedgerDirPath, "tables", "tvar"));

    const [stateExists, metaExists, tvarExists] = await Promise.all([
        stateFile.exists(),
        metaFile.exists(),
        tvarFile.exists(),
    ]);
    console.log(
        `Ancillary files: state=${stateExists} meta=${metaExists} tvar=${tvarExists}`,
    );
    if (stateExists) {
        console.log(`State size: ${stateFile.size} bytes`);
    }
    if (tvarExists) {
        console.log(`TVAR size: ${tvarFile.size} bytes`);
    }

    console.warn(
        "ANCILLARY UTxO EXTRACT BLOCKED: indefinite CBOR / SubCborRef — " +
            "use immutable chunk replay (read-raw-chunks / processChunk) for density.",
    );
    // Intentionally no Cbor.parse of full tvar (OOM) and no fake UTxO inserts.
    return;
}

/** @deprecated kept for reference; not called — see A2 blocker above */
async function processLedgerState(stateData: any) {
    console.log("Processing ledger state...");
    console.log(
        "[BLOCKED] Indefinite CBOR maps / SubCborRef prevent UTxO extraction.",
    );

    let utxoCount = 0;
    let stakeCount = 0;
    let delegationCount = 0;

    try {
        if (stateData.utxo || stateData.utxos) {
            const utxoSet = stateData.utxo || stateData.utxos;
            console.log(`Found UTxO set with ${Object.keys(utxoSet).length} entries`);
            utxoCount = Math.min(Object.keys(utxoSet).length, 10);
        }
        if (stateData.stake || stateData.stakes) {
            const stakeSet = stateData.stake || stateData.stakes;
            console.log(`Found stake distribution with ${Object.keys(stakeSet).length} entries`);
            stakeCount = Math.min(Object.keys(stakeSet).length, 10);
        }
        if (stateData.delegations || stateData.delegs) {
            const delegationSet = stateData.delegations || stateData.delegs;
            console.log(`Found delegations with ${Object.keys(delegationSet).length} entries`);
            delegationCount = Math.min(Object.keys(delegationSet).length, 10);
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
