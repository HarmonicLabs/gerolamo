import { type Certificate, CertificateType, MultiEraBlock, TxBody, TxWithdrawals } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export async function applyBlock(
    block: MultiEraBlock,
    _slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    const actualBlock = block.block;

    // Apply all transactions concurrently
    await Promise.all(
        actualBlock.transactionBodies.map((txBody) =>
            applyTransaction(txBody, blockHash)
        ),
    );
}

async function applyTransaction(
    txBody: TxBody,
    blockHash: Uint8Array,
): Promise<void> {
    // Compute transaction ID (hash of tx body)
    const txId = toHex(blake2b_256(txBody.toCborBytes()));

    // Collect input UTxO refs for bulk delete
    const inputRefs = txBody.inputs.map((input) =>
        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
    );

    // Bulk query existing UTxOs and log as deltas
    if (inputRefs.length > 0) {
        const existingUtxos = await sql`
            SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN ${
            sql(inputRefs)
        }
        `.values() as [string, string][];

        // Bulk insert spend deltas
        const spendDeltas = existingUtxos.map(([utxo_ref, tx_out]) => [
            blockHash,
            "spend",
            tx_out,
        ]);

        if (spendDeltas.length > 0) {
            await sql`
                INSERT INTO utxo_deltas (block_hash, action, utxo)
                VALUES ${sql(spendDeltas)}
            `;
        }
    }
    // Bulk delete spent UTxOs (for now, but deltas allow rollback)
    if (inputRefs.length > 0) {
        await sql`DELETE FROM utxo WHERE utxo_ref IN ${sql(inputRefs)}`;
    }

    // Collect output data for bulk insert
    const outputData = txBody.outputs.map((output, i) => {
        const utxoRef = `${txId}:${i}`;
        const txOutJson = JSON.stringify({
            address: output.address.toString(),
            amount: output.value.lovelaces.toString(),
            assets: output.value.map.length > 0
                ? Object.fromEntries(
                    output.value.map.map(({ policy, assets }) => [
                        policy.toString(),
                        Object.fromEntries(assets.map(({ name, quantity }) => [
                            toHex(name),
                            quantity.toString(),
                        ])),
                    ]),
                )
                : {},
        });
        return [utxoRef, txOutJson];
    });

    // Bulk insert create deltas
    const createDeltas = outputData.map(([_ref, json]) => [
        blockHash,
        "create",
        json,
    ]);

    if (createDeltas.length > 0) {
        await sql`
            INSERT INTO utxo_deltas (block_hash, action, utxo)
            VALUES ${sql(createDeltas)}
        `;
    }
    // Bulk insert new UTxOs
    if (outputData.length > 0) {
        await sql`
            INSERT OR REPLACE INTO utxo (utxo_ref, tx_out)
            VALUES ${sql(outputData)}
        `;
    }

    // Handle certificates (log as deltas)
    if (txBody.certs) {
        await applyCertificates(txBody.certs, blockHash);
    }

    // Handle withdrawals (log as deltas)
    if (txBody.withdrawals) {
        await applyWithdrawals(txBody.withdrawals, blockHash);
    }

    // Handle fees (log as delta)
    if (txBody.fee) {
        await sql`
            INSERT INTO utxo_deltas (block_hash, action, utxo)
            VALUES (${blockHash}, 'fee', ${
            JSON.stringify({ amount: txBody.fee.toString() })
        })
        `;
        await sql`UPDATE chain_account_state SET treasury = treasury + ${txBody.fee} WHERE id = 1`;
    }

    // TODO: Handle minting, burning, collateral, etc.
}

async function applyCertificates(
    certs: Certificate[],
    blockHash: Uint8Array,
): Promise<void> {
    // Bulk insert certificate deltas
    const certDeltas = certs.map((cert) => {
        const certAny = cert as any; // Type assertion due to union type complexity
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();

        return [
            blockHash,
            "cert",
            JSON.stringify({
                type: cert.certType,
                stakeCred: stakeCred ? toHex(stakeCred) : null,
                poolId: certAny.poolKeyHash?.toString() ||
                    certAny.poolParams?.operator?.toString() ||
                    certAny.poolHash?.toString(),
            }),
        ];
    });

    if (certDeltas.length > 0) {
        await sql`
            INSERT INTO utxo_deltas (block_hash, action, utxo)
            VALUES ${sql(certDeltas)}
        `;
    }

    // Apply certificate changes concurrently
    await Promise.all(certs.map(async (cert) => {
        const certAny = cert as any; // Type assertion due to union type complexity
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();

        switch (cert.certType) {
            case CertificateType.StakeRegistration: // StakeRegistration
                if (stakeCred) {
                    await sql`
                        INSERT OR REPLACE INTO stake (stake_credentials, amount)
                        VALUES (${stakeCred}, 0)
                    `;
                }
                break;
            case CertificateType.StakeDeRegistration: // StakeDeRegistration
                if (stakeCred) {
                    await sql`DELETE FROM stake WHERE stake_credentials = ${stakeCred}`;
                    await sql`DELETE FROM delegations WHERE stake_credentials = ${stakeCred}`;
                }
                break;
            case CertificateType.StakeDelegation: // StakeDelegation
                if (stakeCred) {
                    const poolId = certAny.poolKeyHash?.toBuffer();
                    if (poolId) {
                        await sql`
                            INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash)
                            VALUES (${stakeCred}, ${poolId})
                        `;
                    }
                }
                break;
            case CertificateType.PoolRegistration: // PoolRegistration
                const poolId = certAny.poolParams?.operator?.toBuffer();
                if (poolId) {
                    // Add new pool to the JSON array in-database
                    const newPoolJson = JSON.stringify({
                        pool_id: toHex(poolId),
                        active_stake: "0", // Will be updated when stake is delegated
                        // Add other pool parameters as needed
                    });
                    await sql`
                        UPDATE pool_distr
                        SET pools = json_insert(pools, '$[#]', json(${newPoolJson}))
                        WHERE id = 1
                    `;
                }
                break;
            case CertificateType.PoolRetirement: // PoolRetirement
                const retiringPoolId = certAny.poolHash?.toBuffer();
                if (retiringPoolId) {
                    // Remove retiring pool from JSON array in-database
                    await sql`
                        UPDATE pool_distr
                        SET pools = (
                            SELECT json_group_array(json(value))
                            FROM json_each(pools)
                            WHERE json_extract(value, '$.pool_id') != ${
                        toHex(retiringPoolId)
                    }
                        )
                        WHERE id = 1
                    `;
                }
                break;
                // Handle other certificate types as needed
        }
    }));
}

async function applyWithdrawals(
    withdrawals: TxWithdrawals,
    blockHash: Uint8Array,
): Promise<void> {
    if (withdrawals.map.length === 0) return;

    // Prepare withdrawal data
    const withdrawalData = withdrawals.map.map(({ rewardAccount, amount }) => ({
        stakeCred: rewardAccount.toBuffer(),
        amount,
    }));

    // Update rewards asynchronously (using individual updates since each has different WHERE clause)
    await Promise.all(
        withdrawalData.map(({ stakeCred, amount }) =>
            sql`UPDATE rewards SET amount = amount - ${amount} WHERE stake_credentials = ${stakeCred}`
        ),
    );

    // Log withdrawal deltas
    const withdrawalDeltas = withdrawalData.map(({ stakeCred, amount }) => [
        blockHash,
        "withdrawal",
        JSON.stringify({
            stakeCred: toHex(stakeCred),
            amount: amount.toString(),
        }),
    ]);

    if (withdrawalDeltas.length > 0) {
        await sql`
            INSERT INTO utxo_deltas (block_hash, action, utxo)
            VALUES ${sql(withdrawalDeltas)}
        `;
    }
}
