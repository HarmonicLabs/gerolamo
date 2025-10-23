import {
    MultiEraBlock,
    ConwayBlock,
    ConwayTxBody,
    ConwayUTxO,
    TxOutRef,
    Hash32,
    Certificate,
    CertStakeRegistration,
    CertStakeDeRegistration,
    CertStakeDelegation,
    CertPoolRegistration,
    CertPoolRetirement,
} from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { SQLNewEpochState } from "./ledger";
import { logger } from "../utils/logger";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export class BlockApplier {
    private ledgerState: SQLNewEpochState;

    constructor(ledgerState: SQLNewEpochState) {
        this.ledgerState = ledgerState;
    }

    /**
     * Apply a validated block to the ledger state
     */
    async applyBlock(block: MultiEraBlock, slot: bigint): Promise<void> {
        try {
            const conwayBlock = block.block as ConwayBlock;

            // 1. Apply transactions
            for (const txBody of conwayBlock.transactionBodies) {
                await this.applyTransaction(txBody);
            }

            // 2. Update treasury (simplified)
            const totalFees = conwayBlock.transactionBodies.reduce(
                (sum, txBody) => sum + txBody.fee,
                0n
            );
            const currentTreasury = await this.ledgerState.getTreasury();
            await this.ledgerState.setTreasury(currentTreasury + totalFees);

            // 3. Update last epoch modified if needed
            // TODO: Implement epoch boundary logic

            logger.debug(`Applied block at slot ${slot} with ${conwayBlock.transactionBodies.length} transactions`);
        } catch (error) {
            logger.error("Block application failed:", error);
            throw error;
        }
    }

    /**
     * Apply a single transaction to the ledger state
     */
    private async applyTransaction(txBody: ConwayTxBody): Promise<void> {
        // 1. Remove spent UTxOs
        const currentUtxo = await this.ledgerState.getUTxO();
        const newUtxo = currentUtxo.filter(utxo => {
            return !txBody.inputs.some(input =>
                input.utxoRef.eq(utxo.utxoRef)
            );
        });

        // 2. Add new UTxOs from outputs
        const txHash = new Hash32(blake2b_256(txBody.toCborBytes()));
        for (let i = 0; i < txBody.outputs.length; i++) {
            const output = txBody.outputs[i];
            const newUtxoEntry = new ConwayUTxO({
                utxoRef: new TxOutRef({ id: txHash, index: i }),
                resolved: output,
            });
            newUtxo.push(newUtxoEntry);
        }

        // 3. Process certificates
        for (const cert of txBody.certs ?? []) {
            await this.processCert(cert);
        }

        // 4. Process withdrawals
        let totalWithdrawals = 0n;
        if (txBody.withdrawals) {
            for (const [rewardAccount, amount] of txBody.withdrawals.map.entries()) {
                totalWithdrawals += amount as unknown as bigint;
                // TODO: Update reward account balance
            }
        }
        const currentTreasury = await this.ledgerState.getTreasury();
        await this.ledgerState.setTreasury(currentTreasury - totalWithdrawals);

        // 5. Update UTxO in ledger state
        await this.ledgerState.setUTxO(newUtxo);
    }

    /**
     * Process a certificate and update the ledger state
     */
    private async processCert(cert: Certificate): Promise<void> {
        if (cert instanceof CertStakeRegistration) {
            // Add stake credential to stake set
            // TODO: Implement stake set management in ledger state
            logger.debug(`Processed stake registration for ${cert.stakeCredential.toCbor().toString()}`);
        } else if (cert instanceof CertStakeDeRegistration) {
            // Remove stake credential from stake set
            logger.debug(`Processed stake deregistration for ${cert.stakeCredential.toCbor().toString()}`);
        } else if (cert instanceof CertStakeDelegation) {
            // Update delegation
            logger.debug(`Processed stake delegation from ${cert.stakeCredential.toCbor().toString()} to ${cert.poolKeyHash.toCbor().toString()}`);
        } else if (cert instanceof CertPoolRegistration) {
            // Register pool
            logger.debug(`Processed pool registration for ${cert.poolParams.operator.toCbor().toString()}`);
        } else if (cert instanceof CertPoolRetirement) {
            // Retire pool
            logger.debug(`Processed pool retirement for ${cert.poolHash.toCbor().toString()}`);
        } else {
            logger.warn(`Unknown certificate type: ${cert.toCbor().toString()}`);
        }
    }

    /**
     * Apply epoch boundary updates
     */
    async applyEpochBoundary(): Promise<void> {
        // TODO: Implement epoch boundary logic
        // - Update stake distribution
        // - Calculate rewards
        // - Reset epoch-specific state
        logger.debug("Applied epoch boundary");
    }
}
