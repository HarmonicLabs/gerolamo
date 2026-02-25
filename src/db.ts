import { sql } from "bun";
import { logger } from "./utils/logger";
import {
    AllegraTxBody,
    AlonzoTxBody,
    BabbageTxBody,
    ConwayTxBody,
    MaryTxBody,
    ShelleyBlock,
    ShelleyTxBody,
} from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

interface HeaderInsertData {
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
}

interface BlockInsertData {
    slot: bigint;
    blockHash: string;
    prevHash: string;
    headerData: Uint8Array;
    blockData: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
}

interface ImmutableChunk {
    chunk_no: number;
    tip_hash: string;
    tip_slot_no: bigint;
    slot_range_start: bigint;
    slot_range_end: bigint;
}

type TxBody =
    | ShelleyTxBody
    | AllegraTxBody
    | MaryTxBody
    | AlonzoTxBody
    | BabbageTxBody
    | ConwayTxBody;

// Top-level functions for database operations

export async function ensureInitialized(): Promise<void> {
    // Volatile headers table
    await sql`
		CREATE TABLE IF NOT EXISTS volatile_headers (
			slot BIGINT PRIMARY KEY,
			header_hash TEXT NOT NULL UNIQUE,
			rollforward_header_cbor BLOB NOT NULL,
			is_valid BOOLEAN DEFAULT TRUE
		)
	`;

    // Protocol parameters table
    await sql`
		CREATE TABLE IF NOT EXISTS protocol_params (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			params JSONB
		)
	`;

    // Chain account state table
    await sql`
		CREATE TABLE IF NOT EXISTS chain_account_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			treasury INTEGER,
			reserves INTEGER
		)
	`;

    // Pool distribution table
    await sql`
		CREATE TABLE IF NOT EXISTS pool_distr (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pools JSONB,
			total_active_stake INTEGER
		)
	`;

    // Blocks made table
    await sql`
		CREATE TABLE IF NOT EXISTS blocks_made (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pool_key_hash BLOB,
			epoch INTEGER,
			block_count INTEGER,
			status TEXT CHECK(status IN ('CURR', 'PREV', 'LEGACY')) NOT NULL DEFAULT 'CURR',
			UNIQUE(pool_key_hash, epoch)
		)
	`;

    // Stake table
    await sql`
		CREATE TABLE IF NOT EXISTS stake (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			amount INTEGER
		)
	`;

    // Delegations table
    await sql`
		CREATE TABLE IF NOT EXISTS delegations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			pool_key_hash BLOB
		)
	`;

    // Rewards table
    await sql`
		CREATE TABLE IF NOT EXISTS rewards (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			amount INTEGER
		)
	`;

    // Likelihoods table (for non-myopic)
    await sql`
		CREATE TABLE IF NOT EXISTS likelihoods (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pool_key_hash BLOB,
			likelihood JSONB
		)
	`;

    // UTxO table
    await sql`
		CREATE TABLE IF NOT EXISTS utxo (
			utxo_ref BLOB,
			tx_out JSONB,
			tx_hash TEXT,
			PRIMARY KEY (utxo_ref)
		)
	`;

    // Certificate state table
    await sql`
		CREATE TABLE IF NOT EXISTS cert_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data JSONB
		)
	`;

    // Pulsing reward update table
    await sql`
		CREATE TABLE IF NOT EXISTS pulsing_rew_update (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data JSONB
		)
	`;

    // Stashed AVVM addresses table
    await sql`
		CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			addresses JSONB
		)
	`;

    // Non-myopic table
    await sql`
		CREATE TABLE IF NOT EXISTS non_myopic (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			reward_pot INTEGER,
			likelihoods_id INTEGER,
			FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
		)
	`;

    // Ledger state table
    await sql`
		CREATE TABLE IF NOT EXISTS ledger_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			utxo_deposited INTEGER,
			utxo_fees INTEGER,
			utxo_donation INTEGER,
			utxo_gov_state BLOB,
			utxo_instant_stake BLOB,
			cert_state_id INTEGER,
			FOREIGN KEY (cert_state_id) REFERENCES cert_state(id)
		)
	`;

    // Snapshots table
    await sql`
		CREATE TABLE IF NOT EXISTS snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_id INTEGER,
			rewards_id INTEGER,
			delegations_id INTEGER,
			FOREIGN KEY (stake_id) REFERENCES stake(id),
			FOREIGN KEY (rewards_id) REFERENCES rewards(id),
			FOREIGN KEY (delegations_id) REFERENCES delegations(id)
		)
	`;

    // Epoch state table
    await sql`
		CREATE TABLE IF NOT EXISTS epoch_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chain_account_state_id INTEGER,
			ledger_state_id INTEGER,
			snapshots_id INTEGER,
			non_myopic_id INTEGER,
			pparams_id INTEGER,
			FOREIGN KEY (chain_account_state_id) REFERENCES chain_account_state(id),
			FOREIGN KEY (ledger_state_id) REFERENCES ledger_state(id),
			FOREIGN KEY (snapshots_id) REFERENCES snapshots(id),
			FOREIGN KEY (non_myopic_id) REFERENCES non_myopic(id),
			FOREIGN KEY (pparams_id) REFERENCES protocol_params(id)
		)
	`;

    // New epoch state table (root)
    await sql`
		CREATE TABLE IF NOT EXISTS new_epoch_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			last_epoch_modified INTEGER,
			prev_blocks_id INTEGER,
			curr_blocks_id INTEGER,
			epoch_state_id INTEGER,
			pulsing_rew_update_id INTEGER,
			pool_distr_id INTEGER,
			stashed_avvm_addresses_id INTEGER,
			FOREIGN KEY (prev_blocks_id) REFERENCES blocks_made(id),
			FOREIGN KEY (curr_blocks_id) REFERENCES blocks_made(id),
			FOREIGN KEY (epoch_state_id) REFERENCES epoch_state(id),
			FOREIGN KEY (pulsing_rew_update_id) REFERENCES pulsing_rew_update(id),
			FOREIGN KEY (pool_distr_id) REFERENCES pool_distr(id),
			FOREIGN KEY (stashed_avvm_addresses_id) REFERENCES stashed_avvm_addresses(id)
		)
	`;

    // Immutable chunks table
    await sql`
		CREATE TABLE IF NOT EXISTS immutable_chunks (
			chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
			chunk_no INTEGER NOT NULL UNIQUE,
			tip_hash TEXT NOT NULL,
			tip_slot_no BIGINT NOT NULL,
			slot_range_start BIGINT NOT NULL,
			slot_range_end BIGINT NOT NULL,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
		)
	`;

    // Immutable blocks table
    await sql`
		CREATE TABLE IF NOT EXISTS immutable_blocks (
			slot INTEGER PRIMARY KEY,
			block_hash BLOB NOT NULL,
			block_data JSONB NOT NULL,
			prev_hash BLOB,
			header_data BLOB,
			rollforward_header_cbor BLOB,
			block_fetch_RawCbor BLOB,
			chunk_id INTEGER,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now')),
			UNIQUE(block_hash),
			FOREIGN KEY (chunk_id) REFERENCES immutable_chunks(chunk_id) ON DELETE CASCADE
		)
	`;

    // Stable state table
    await sql`
		CREATE TABLE IF NOT EXISTS stable_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			immutable_tip_hash BLOB,
			immutable_tip_slot INTEGER,
			total_blocks INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;

    // Volatile blocks table
    await sql`
		CREATE TABLE IF NOT EXISTS blocks (
			hash BLOB PRIMARY KEY,
			slot INTEGER NOT NULL,
			header_data BLOB,
			block_data BLOB,
			block_fetch_RawCbor BLOB,
			is_valid BOOLEAN DEFAULT TRUE,
			prev_hash BLOB,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
		)
	`;

    // UTxO deltas table
    await sql`
		CREATE TABLE IF NOT EXISTS utxo_deltas (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			block_hash BLOB NOT NULL,
			action TEXT NOT NULL CHECK(action IN ('spend', 'create', 'cert', 'fee', 'withdrawal')),
			utxo JSONB NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;

    // Indexes for volatile_headers
    await sql`
		CREATE INDEX IF NOT EXISTS idx_volatile_headers_hash ON volatile_headers(header_hash);
		CREATE INDEX IF NOT EXISTS idx_volatile_headers_slot ON volatile_headers(slot);
	`;

    // Indexes for volatile blocks
    await sql`
		CREATE INDEX IF NOT EXISTS idx_volatile_slot ON blocks (slot);
		CREATE INDEX IF NOT EXISTS idx_volatile_hash ON blocks (hash);
		CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON blocks (prev_hash);
	`;

    // Indexes for immutable blocks
    await sql`
		CREATE INDEX IF NOT EXISTS idx_immutable_slot ON immutable_blocks (slot);
		CREATE INDEX IF NOT EXISTS idx_immutable_hash ON immutable_blocks (block_hash);
		CREATE INDEX IF NOT EXISTS idx_immutable_chunk ON immutable_blocks (chunk_id);
	`;

    // Index for utxo table
    await sql`
		CREATE INDEX IF NOT EXISTS idx_utxo_tx_hash ON utxo(tx_hash)
	`;

    // Trigger GC (delete invalid old blocks; customize k=2160)
    await sql`
		CREATE TRIGGER IF NOT EXISTS gc_volatile AFTER INSERT ON blocks
		BEGIN
			DELETE FROM blocks WHERE slot < (SELECT MAX(slot) - 2160 FROM blocks) AND is_valid = FALSE;
			DELETE FROM volatile_headers WHERE slot < (SELECT MAX(slot) - 2160 FROM volatile_headers) AND is_valid = FALSE;
		END
	`;

    logger.info("DB initialized with WAL mode for concurrency");
}

export async function getBlockByHash(hash: string): Promise<any> {
    const result = await sql`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE hash = ${hash}
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE block_hash = ${hash}
		`.values();
    return result[0] || null;
}

export async function getBlockBySlot(slot: bigint): Promise<any> {
    const result = await sql`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE slot = ${slot}
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE slot = ${slot}
		`.values();
    return result[0] || null;
}

export async function getTransactionByTxId(txid: string): Promise<any> {
    const result = await sql`SELECT * FROM transactions WHERE txid = ${txid}`
        .values();
    return result[0] || null;
}

export async function getBlocksInEpoch(epoch: number): Promise<any[]> {
    return await sql`
			SELECT * FROM volatile_blocks vb
			INNER JOIN transactions t ON vb.block_hash = t.block_hash
			WHERE t.epoch = ${epoch}
			UNION
			SELECT * FROM immutable_blocks ib
			INNER JOIN transactions t ON ib.block_hash = t.block_hash
			WHERE t.epoch = ${epoch}
		`.values();
}

export async function getMaxSlot(): Promise<bigint> {
    const result = await sql`SELECT MAX(slot) as max_slot FROM blocks`.values();
    const maxSlot = BigInt(result[0]?.max_slot ?? 0);
    return maxSlot;
}

export async function getValidHeadersBefore(
    cutoffSlot: bigint,
): Promise<any[]> {
    return await sql`SELECT * FROM volatile_headers WHERE slot < ${cutoffSlot} AND is_valid = TRUE ORDER BY slot ASC`
        .values();
}

export async function getValidBlocksBefore(cutoffSlot: bigint): Promise<any[]> {
    return await sql`SELECT * FROM blocks WHERE slot < ${cutoffSlot} AND is_valid = TRUE ORDER BY slot ASC`
        .values();
}

export async function getNextChunk(): Promise<{ next_chunk: number }> {
    const result =
        await sql`SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks`
            .values();
    return result[0];
}

export async function getLedgerSnapshot(snapshotNo: number): Promise<any> {
    const result =
        await sql`SELECT * FROM ledger_snapshots WHERE snapshot_no = ${snapshotNo}`
            .values();
    return result[0] || null;
}

export async function insertHeaderBatchVolatile(
    records: Array<HeaderInsertData>,
): Promise<void> {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map((r) => r.headerHash));
    if (hashes.size !== records.length) {
        logger.warn(
            `Batch has ${records.length - hashes.size} duplicate hashes!`,
        );
    }

    await sql`
		INSERT OR IGNORE INTO volatile_headers 
		(slot, header_hash, rollforward_header_cbor)
		VALUES ${
        sql(records.map(
            (r) => [r.slot, r.headerHash, r.rollforward_header_cbor],
        ))
    }
	`;
    logger.info(
        `Committed ${records.length} headers to volatile_headers (ignored dups)`,
    );
}

export async function insertBlockVolatile(
    block: BlockInsertData,
): Promise<void> {
    await sql`
			INSERT INTO volatile_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor)
			VALUES (${block.slot}, ${block.blockHash}, ${block.prevHash}, ${block.headerData}, ${block.blockData}, ${block.block_fetch_RawCbor})
			ON CONFLICT(block_hash) DO UPDATE SET
				slot = excluded.slot,
				prev_hash = excluded.prev_hash,
				header_data = excluded.header_data,
				block_data = excluded.block_data,
				block_fetch_RawCbor = excluded.block_fetch_RawCbor
		`;
}

export async function insertBlockBatchVolatile(
    records: Array<BlockInsertData>,
): Promise<void> {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map((r) => r.blockHash));
    if (hashes.size !== records.length) {
        logger.warn(
            `Batch has ${records.length - hashes.size} duplicate hashes!`,
        );
    }

    await sql.begin(async (tx) => {
        await tx`INSERT OR IGNORE INTO blocks (hash, slot, header_data, block_data, block_fetch_RawCbor, is_valid, prev_hash) VALUES ${
            sql(records.map(
                (r) => [
                    r.blockHash,
                    Number(r.slot),
                    r.headerData,
                    r.blockData,
                    r.block_fetch_RawCbor,
                    true,
                    r.prevHash,
                ],
            ))
        }`;
    });
    logger.info(
        `Committed ${records.length} blocks to volatile_blocks (ignored dups)`,
    );
}

export async function insertChunk(chunk: ImmutableChunk): Promise<number> {
    await sql`
			INSERT INTO immutable_chunks (chunk_no, tip_hash, tip_slot_no, slot_range_start, slot_range_end)
			VALUES (${chunk.chunk_no}, ${chunk.tip_hash}, ${chunk.tip_slot_no}, ${chunk.slot_range_start}, ${chunk.slot_range_end})
		`;
    const result = await sql`SELECT last_insert_rowid()`.values();
    return Number(result[0]["last_insert_rowid()"]);
}

export async function insertImmutableBlocks(
    blocks: any[],
    chunk_id: number,
): Promise<void> {
    for (const block of blocks) {
        await sql`
				INSERT INTO immutable_blocks (slot, block_hash, block_data, prev_hash, header_data, rollforward_header_cbor, block_fetch_RawCbor, chunk_id)
				VALUES (${block.slot}, ${block.block_hash}, ${
            JSON.stringify(block.block_data)
        }, ${block.prev_hash}, ${block.header_data}, ${block.rollforward_header_cbor}, ${block.block_fetch_RawCbor}, ${chunk_id})
			`;
    }
}

export async function deleteVolatileBlocks(
    blockHashes: string[],
): Promise<void> {
    await sql`DELETE FROM blocks WHERE hash IN ${sql(blockHashes)}`;
}

export async function deleteVolatileHeaders(
    headerHashes: string[],
): Promise<void> {
    await sql`DELETE FROM volatile_headers WHERE header_hash IN ${
        sql(headerHashes)
    }`;
}

export async function createChunk(oldBlocks: any[]): Promise<ImmutableChunk> {
    if (oldBlocks.length === 0) throw new Error("No blocks to chunk");

    // Assume oldBlocks sorted by slot ASC
    const firstBlock = oldBlocks[0];
    const lastBlock = oldBlocks[oldBlocks.length - 1];

    // Get next chunk_no
    const nextChunk = await getNextChunk();
    const chunk_no = nextChunk.next_chunk;

    return {
        chunk_no,
        tip_hash: lastBlock.hash,
        tip_slot_no: lastBlock.slot,
        slot_range_start: firstBlock.slot,
        slot_range_end: lastBlock.slot,
    };
}

function logDbError(operation: string, err: unknown): void {
    logger.error(`DB ${operation} failed:`, err);
}

export async function compact(): Promise<void> {
    const cutoff = (await getMaxSlot()) - BigInt(2160);
    const oldBlocks = await getValidBlocksBefore(cutoff);
    const oldHeaders = await getValidHeadersBefore(cutoff);

    if (oldBlocks.length === 0) return;

    const headerMap = new Map(
        oldHeaders.map((h: any) => [h.header_hash, h.rollforward_header_cbor]),
    );
    for (const block of oldBlocks) {
        block.rollforward_header_cbor = headerMap.get(block.hash) ??
            new Uint8Array(0);
    }

    const chunk = await createChunk(oldBlocks);
    let chunk_id!: number;
    try {
        chunk_id = await insertChunk(chunk);
    } catch (err) {
        logDbError("insert chunk", err);
        throw err;
    }
    try {
        await insertImmutableBlocks(oldBlocks, chunk_id);
    } catch (err) {
        logDbError("insert immutable_blocks", err);
        throw err;
    }
    try {
        await deleteVolatileBlocks(oldBlocks.map((b: any) => b.hash));
    } catch (err) {
        logDbError("delete volatile_blocks", err);
        throw err;
    }
    try {
        await deleteVolatileHeaders(oldHeaders.map((h: any) => h.header_hash));
    } catch (err) {
        logDbError("delete volatile_headers", err);
        throw err;
    }
    logger.info(
        `GC'd ${oldBlocks.length} blocks + ${oldHeaders.length} headers (w/ RawCbor + rollforward_header_cbor) to chunk ${chunk.chunk_no}`,
    );
}

export async function getUtxosByRefs(
    utxoRefs: string[],
): Promise<Array<{ utxo_ref: string; amount: any }>> {
    if (utxoRefs.length === 0) return [];
    const rows = await sql`SELECT utxo_ref, json_extract(tx_out, '$.amount') as amount FROM utxo WHERE utxo_ref IN ${sql(utxoRefs)}`.values() as Array<{ utxo_ref: string; amount: any }>;
    return rows;
}

export async function getUtxoByRef(
    utxoRef: string,
): Promise<{ utxo_ref: string; tx_out: string } | null> {
    const result =
        await sql`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref = ${utxoRef}`
            .values();
    return result[0] as { utxo_ref: string; tx_out: string } | null;
}

export async function getUtxosByTxHash(
    txHash: string,
): Promise<Array<{ utxo_ref: string; tx_out: string }>> {
    return await sql`SELECT utxo_ref, tx_out FROM utxo WHERE tx_hash = ${txHash} ORDER BY CAST(substr(utxo_ref, 66) AS INTEGER)`
        .values() as Array<{ utxo_ref: string; tx_out: string }>;
}

export async function getAllStake(): Promise<
    Array<{ stake_credentials: Uint8Array; amount: number }>
> {
    return await sql`SELECT stake_credentials, amount FROM stake`
        .values() as Array<{ stake_credentials: Uint8Array; amount: number }>;
}

export async function getAllDelegations(): Promise<
    Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>
> {
    return await sql`SELECT stake_credentials, pool_key_hash FROM delegations`
        .values() as Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>;
}

export async function applyTransaction(
    txBody: TxBody,
    blockHash: Uint8Array,
): Promise<void> {
    const txId = txBody.hash.toString(); // Canonical blake2b_256(txBody CBOR) hex from ledger-ts

    if (!txBody.inputs || !Array.isArray(txBody.inputs)) {
        logger.warn(
            `Skipping tx ${txId} due to invalid inputs:`,
            txBody.inputs,
        );
        return;
    }

    const inputRefs = txBody.inputs.map((input: any) =>
        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
    );

    logger.info(`Input refs: ${inputRefs.length} - ${inputRefs.slice(0, 3).join(', ')}`);

    if (inputRefs.length > 0) {
        const existingUtxos =
            await sql`SELECT tx_out FROM utxo WHERE utxo_ref IN ${
                sql(inputRefs)
            }`.values() as [string][];
        if (existingUtxos.length > 0) {
            // Insert spend deltas individually (Uint8Array in bulk has issues)
            for (const [tx_out] of existingUtxos) {
                await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (${blockHash}, "spend", ${tx_out})`;
            }
            // Delete spent UTxOs in bulk
            await sql`DELETE FROM utxo WHERE utxo_ref IN ${sql(inputRefs)}`;
        }
    }

    if (!txBody.outputs || !Array.isArray(txBody.outputs)) {
        logger.warn(
            `Skipping tx ${txId} due to invalid outputs:`,
            txBody.outputs,
        );
        return;
    }

    // Force tuple typing in map return
    const outputData: [string, string, string][] = txBody.outputs.map(
        (output: any, i: number) => {
            const utxoRef = `${txId}:${i}`;
            const assetsObj: Record<string, Record<string, string>> = {};
            const multiAssets = Array.isArray(output.value?.map)
                ? output.value.map
                : [];
            multiAssets.forEach((ma: any) => {
                const policyStr = ma.policy.toString();
                const assetObj: Record<string, string> = {};
                (Array.isArray(ma.assets) ? ma.assets : []).forEach(
                    (asset: any) => {
                        assetObj[toHex(asset.name)] = asset.quantity.toString();
                    },
                );
                assetsObj[policyStr] = assetObj;
            });

            const txOutJson = JSON.stringify({
                address: output.address?.toString() || "",
                amount: output.value?.lovelaces?.toString() || "0",
                assets: assetsObj,
            });
            return [utxoRef, txOutJson, txId] as [string, string, string];
        },
    );

    if (outputData.length > 0) {
        // Insert UTxO deltas in bulk
        await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES ${
            sql(outputData.map(([_, json]) => [blockHash, "create", json]))
        }`;

        // Insert UTxOs individually (bulk operations work for homogeneous string data, but individual is more reliable)
        for (const [ref, json, txhash] of outputData) {
            await sql`INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (${ref}, ${json}, ${txhash})`;
        }
    }

    if (txBody.certs && Array.isArray(txBody.certs)) {
        await applyCertificates(txBody.certs, blockHash);
    }

    if (txBody.withdrawals && Array.isArray(txBody.withdrawals)) {
        await applyWithdrawals(txBody.withdrawals, blockHash);
    }

    if (txBody.fee) {
        await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (${blockHash}, "fee", ${
            JSON.stringify({ amount: txBody.fee.toString() })
        })`;
        await sql`UPDATE chain_account_state SET treasury = treasury + ${txBody.fee} WHERE id = 1`;
    }

    // TODO: Handle minting, burning, collateral, etc.
    if (txBody.certs) {
        await applyCertificates(txBody.certs, blockHash);
    }
}

export async function applyCertificates(
    certs: any[],
    blockHash: Uint8Array,
): Promise<void> {
    const certDeltas: string[] = [];
    for (const cert of certs) {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();

        certDeltas.push(JSON.stringify({
            type: cert.certType,
            stakeCred: stakeCred ? toHex(stakeCred) : null,
            poolId: certAny.poolKeyHash?.toString() ||
                certAny.poolParams?.operator?.toString() ||
                certAny.poolHash?.toString(),
        }));
    }
    if (certDeltas.length) {
        await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES ${
            sql(certDeltas.map((json) => [blockHash, "cert", json]))
        }`;
    }

    await Promise.all(certs.map(async (cert) => {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();
        switch (cert.certType) {
            case 0: // CertificateType.StakeRegistration
                if (stakeCred) {
                    await sql`INSERT OR REPLACE INTO stake (stake_credentials, amount) VALUES (${stakeCred}, 0)`;
                }
                break;
            case 1: // CertificateType.StakeDeRegistration
                if (stakeCred) {
                    await sql`DELETE FROM stake WHERE stake_credentials = ${stakeCred}`;
                    await sql`DELETE FROM delegations WHERE stake_credentials = ${stakeCred}`;
                }
                break;
            case 2: // CertificateType.StakeDelegation
                if (stakeCred) {
                    const poolId = certAny.poolKeyHash?.toBuffer();
                    if (poolId) {
                        await sql`INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash) VALUES (${stakeCred}, ${poolId})`;
                    }
                }
                break;
            case 3: // CertificateType.PoolRegistration
                const poolId = certAny.poolParams?.operator?.toBuffer();
                if (poolId) {
                    const newPoolJson = JSON.stringify({
                        pool_id: toHex(poolId),
                        active_stake: "0",
                    });
                    await sql`UPDATE pool_distr SET pools = json_insert(pools, "$[#]", json(${newPoolJson})) WHERE id = 1`;
                }
                break;
            case 4: // CertificateType.PoolRetirement
                const retiringPoolId = certAny.poolHash?.toBuffer();
                if (retiringPoolId) {
                    await sql`UPDATE pool_distr SET pools = (SELECT json_group_array(json(value)) FROM json_each(pools) WHERE json_extract(value, '$.pool_id') != ${
                        toHex(retiringPoolId)
                    }) WHERE id = 1`;
                }
                break;
        }
    }));
}

export async function applyWithdrawals(
    withdrawals: any,
    blockHash: Uint8Array,
): Promise<void> {
    if (withdrawals.map.length === 0) return;

    const withdrawalData = withdrawals.map.map((
        { rewardAccount, amount }: any,
    ) => ({
        stakeCred: rewardAccount.toBuffer(),
        amount,
    }));
    for (const { stakeCred, amount } of withdrawalData) {
        await sql`UPDATE rewards SET amount = amount - ${amount} WHERE stake_credentials = ${stakeCred}`;
    }
    await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES ${
        sql(withdrawalData.map((
            { stakeCred, amount },
        ) => [
            blockHash,
            "withdrawal",
            JSON.stringify({
                stakeCred: toHex(stakeCred),
                amount: amount.toString(),
            }),
        ]))
    }`;
}

export async function rollbackChainTo(
    slot: bigint,
): Promise<
    { blocksDeleted: number; headersDeleted: number; deltasDeleted: number }
> {
    const counts = { blocksDeleted: 0, headersDeleted: 0, deltasDeleted: 0 };

    // Pre-count
    counts.blocksDeleted =
        (await sql`SELECT COUNT(*) FROM blocks WHERE slot > ${slot}`.values())[
            0
        ]["COUNT(*)"] || 0;
    counts.headersDeleted =
        (await sql`SELECT COUNT(*) FROM volatile_headers WHERE slot > ${slot}`
            .values())[0]["COUNT(*)"] || 0;
    counts.deltasDeleted =
        (await sql`SELECT COUNT(*) FROM utxo_deltas WHERE block_hash IN (SELECT hash FROM blocks WHERE slot > ${slot})`
            .values())[0]["COUNT(*)"] || 0;

    logger.rollback(
        `Pre-rollback to slot ${slot}: blocksDeleted=${counts.blocksDeleted}, headersDeleted=${counts.headersDeleted}, deltasDeleted=${counts.deltasDeleted}`,
    );

    const beforeTip = await getMaxSlot();
    const deletedBlocks =
        await sql`SELECT slot, hash FROM blocks WHERE slot > ${slot} ORDER BY slot DESC LIMIT 50`
            .values();
    logger.rollback(
        `Rollback to slot ${slot}; beforeTip slot ${beforeTip.toString()}; deleting ${counts.blocksDeleted} blocks (top 50: [${
            deletedBlocks.map((b: any) => `${b.slot}:${b.hash.slice(0, 8)}`)
                .join(", ") || "none"
        }])`,
    );

    await sql.begin(async (tx) => {
        await tx`DELETE FROM utxo_deltas WHERE block_hash IN (SELECT hash FROM blocks WHERE slot > ${slot})`;
        await tx`DELETE FROM volatile_headers WHERE slot > ${slot}`;
        await tx`DELETE FROM blocks WHERE slot > ${slot}`;
    });

    const afterTip = await getMaxSlot();
    logger.rollback(
        `Post-rollback to slot ${slot}; afterTip: ${afterTip.toString()}`,
    );

    return counts;
}
