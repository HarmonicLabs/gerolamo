import {
    Certificate,
    CertificateType,
    MultiEraBlock,
    TxBody,
    TxWithdrawals,
} from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export async function applyBlock(
    block: MultiEraBlock,
    _slot: bigint,
): Promise<void> {
    if (!block.block) return; // Skip if block not parsed

    const actualBlock = block.block;

    // Process all transactions in the block concurrently
    await Promise.all(
        actualBlock.transactionBodies.map((txBody) => applyTransaction(txBody)),
    );

    // TODO: Update other ledger state components (certificates, rewards, etc.)
    // For now, only UTxO updates are implemented
}

async function applyTransaction(txBody: TxBody): Promise<void> {
    // Compute transaction ID (hash of tx body)
    const txId = toHex(blake2b_256(txBody.toCborBytes()));

    // Collect input UTxO refs for bulk delete
    const inputRefs = txBody.inputs.map((input) =>
        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
    );

    // Bulk delete spent UTxOs
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

    // Bulk insert new UTxOs
    if (outputData.length > 0) {
        await sql`
            INSERT OR REPLACE INTO utxo (utxo_ref, tx_out)
            VALUES ${sql(outputData)}
        `;
    }

    // Handle certificates
    if (txBody.certs) {
        await applyCertificates(txBody.certs);
    }

    // Handle withdrawals
    if (txBody.withdrawals) {
        await applyWithdrawals(txBody.withdrawals);
    }

    // Handle fees (add to treasury)
    if (txBody.fee) {
        await sql`UPDATE chain_account_state SET treasury = treasury + ${txBody.fee} WHERE id = 1`;
    }

    // TODO: Handle minting, burning, collateral, etc.
}

async function applyCertificates(certs: Certificate[]): Promise<void> {
    for (const cert of certs) {
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
                        pool_id: poolId,
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
                            WHERE json_extract(value, '$.pool_id') != ${retiringPoolId}
                        )
                        WHERE id = 1
                    `;
                }
                break;
                // Handle other certificate types as needed
        }
    }
}

async function applyWithdrawals(withdrawals: TxWithdrawals): Promise<void> {
    // withdrawals.map is TxWithdrawalsMapBigInt
    for (const { rewardAccount, amount } of withdrawals.map) {
        const stakeCred = rewardAccount.toBuffer();
        await sql`
            UPDATE rewards SET amount = amount - ${amount}
            WHERE stake_credentials = ${stakeCred}
        `;
    }
}
