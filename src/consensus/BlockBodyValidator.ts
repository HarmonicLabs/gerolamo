import {
    AllegraBlock,
    AlonzoBlock,
    BabbageBlock,
    CertificateType,
    ConwayBlock,
    defaultConwayProtocolParameters,
    isShelleyProtocolParameters,
    MaryBlock,
    MultiEraBlock,
    ShelleyBlock,
    TxBody,
    TxOut,
    Value,
} from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { getShelleyGenesisConfig } from "../utils/paths";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import { logger } from "../utils/logger";

import { getUtxosByRefs, getAllStake, getAllDelegations } from "../db";

let genesisCache: ShelleyGenesisConfig | null = null;

async function getCachedShelleyGenesis(
    config: any,
): Promise<ShelleyGenesisConfig | null> {
    if (genesisCache) return genesisCache;
    try {
        genesisCache = await getShelleyGenesisConfig(config);
        return genesisCache;
    } catch (error) {
        logger.error("Failed to load Shelley genesis config:", error);
        return null;
    }
}

type CardanoBlock =
    | ConwayBlock
    | BabbageBlock
    | AlonzoBlock
    | MaryBlock
    | AllegraBlock
    | ShelleyBlock;

export class BlockBodyValidator {
    constructor(private config: any) {}

    private getEraBlock(
        block: MultiEraBlock,
    ): AlonzoBlock | BabbageBlock | ConwayBlock | null {
        if (block.era < 5) return null; // Pre-Alonzo (no scripts/collateral)
        // Assume correct type based on era
        return block.block as AlonzoBlock | BabbageBlock | ConwayBlock;
    }

    public async validate(
        block: MultiEraBlock,
    ): Promise<boolean | null> {
        if (!block.block) return true; // Skip if block not parsed
        const actualBlock = this.getEraBlock(block);
        if (actualBlock === null) return null; // Unsupported era

        logger.info("Starting block body validation", {
            era: block.era,
            slot: actualBlock.header.body.slot.toString(),
        });

        const genesis = await getCachedShelleyGenesis(this.config);
        if (!genesis) return false;

        const txCountValid = this.validateTransactionCountMatch(actualBlock);
        if (!txCountValid) {
            logger.warn(
                `Block body validation failed: transaction count mismatch`,
            );
            return false;
        }

        const noInvalidTxs = this.validateNoInvalidTxs(actualBlock);
        if (!noInvalidTxs) {
            logger.warn(
                `Block body validation failed: invalid transactions present`,
            );
            return false;
        }

        const utxoBalanceValid = await this.validateUTxOBalance(actualBlock);
        if (!utxoBalanceValid) {
            logger.warn(`Block body validation failed: UTxO balance invalid`);
            return false;
        }

        const feesValid = await this.validateFeesCorrect(actualBlock, genesis);
        if (!feesValid) {
            logger.warn(`Block body validation failed: fees incorrect`);
            return false;
        }

        const validityIntervalValid = this.validateValidityInterval(
            actualBlock,
        );
        if (!validityIntervalValid) {
            logger.warn(
                `Block body validation failed: validity interval invalid`,
            );
            return false;
        }

        const multiAssetsValid = await this.validateMultiAssetsBalance(
            actualBlock,
            genesis,
        );
        if (!multiAssetsValid) {
            logger.warn(
                `Block body validation failed: multi-assets balance invalid`,
            );
            return false;
        }

        const collateralValid = await this.validateCollateralValid(actualBlock);
        if (!collateralValid) {
            logger.warn(`Block body validation failed: collateral invalid`);
            return false;
        }

        const certsValid = await this.validateCertificatesValid(actualBlock);
        if (!certsValid) {
            logger.warn(`Block body validation failed: certificates invalid`);
            return false;
        }

        const scriptsValid = this.validateScriptsValid(actualBlock);
        if (!scriptsValid) {
            logger.warn(`Block body validation failed: scripts invalid`);
            return false;
        }

        const sizeLimitsValid = await this.validateSizeLimits(
            actualBlock,
            genesis,
        );
        if (!sizeLimitsValid) {
            logger.warn(`Block body validation failed: size limits exceeded`);
            return false;
        }

        logger.info("Block body validation passed all checks", {
            era: block.era,
            slot: actualBlock.header.body.slot.toString(),
        });
        return true;
    }

    private validateTransactionCountMatch(
        block: CardanoBlock,
    ): boolean {
        // Implementation
        if (!block.transactionBodies) return true; // Skip if not present
        return block.transactionBodies.length ===
            block.transactionWitnessSets.length;
    }

    private validateNoInvalidTxs(
        _block: CardanoBlock,
    ): boolean {
        // TODO: Implement Phase-2 script validation
        // For now, assume all txs are valid
        return true;
    }

    private async validateUTxOBalance(
        block: CardanoBlock,
    ): Promise<boolean> {
        // Collect all UTxO references that are inputs to transactions in this block
        if (block.transactionBodies.length === 0) {
            return true; // No inputs to validate
        }

        const inputUtxoRefs = block.transactionBodies.map(
            (txBody) =>
                txBody.inputs.map(
                    (input) =>
                        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`,
                ),
        ).flat();

        // Query only the UTxOs that are inputs to this block with extracted amount
        const utxoRows = await getUtxosByRefs(inputUtxoRefs);

        // Create a lookup map for efficient access
        const utxoMap = new Map(
            utxoRows.map(
                (
                    { utxo_ref, amount },
                ) => [utxo_ref, { utxo_ref, amount: BigInt(amount) }],
            ),
        );

        for (const txBody of block.transactionBodies) {
            let inputValue = 0n;

            // Validate each input exists and accumulate input value
            for (const input of txBody.inputs) {
                const utxoRef =
                    `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.warn(`UTxO not found: ${utxoRef}`);
                    return false;
                }

                inputValue += row.amount;
            }

            // Calculate output value
            let outputValue = 0n;
            for (const output of txBody.outputs) {
                outputValue += output.value.lovelaces;
            }

            // Check that inputs cover outputs + fee
            if (inputValue < outputValue + txBody.fee) {
                logger.error(
                    `Insufficient input value for transaction: ${inputValue} < ${outputValue} + ${txBody.fee}`,
                );
                return false;
            }
        }

        return true;
    }

    private async validateFeesCorrect(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
    ): Promise<boolean> {
        const minFeeA = genesis.protocolParams.minFeeA;
        const minFeeB = genesis.protocolParams.minFeeB;

        return block.transactionBodies.every((txBody: any) => {
            const txSize = txBody.toCborBytes().length;
            const calculatedFee = BigInt(minFeeA) * BigInt(txSize) +
                BigInt(minFeeB);
            const isValid = txBody.fee >= calculatedFee;

            if (!isValid) {
                logger.error(
                    `Invalid fee for transaction: expected >= ${calculatedFee}, got ${txBody.fee}`,
                );
            }

            return isValid;
        });
    }

    private validateValidityInterval(
        block: CardanoBlock,
    ): boolean {
        if (block.transactionBodies.length === 0) return true;
        // Implementation
        return block.transactionBodies.map(
            (txBody) =>
                (!("validityIntervalStart" in txBody) ||
                    txBody.validityIntervalStart === undefined ||
                    txBody.validityIntervalStart! <= block.header.body.slot) &&
                (!("ttl" in txBody) || txBody.ttl === undefined ||
                    ("validityIntervalStart" in txBody &&
                        txBody.validityIntervalStart !== undefined &&
                        txBody.validityIntervalStart! + txBody.ttl! >
                            block.header.body.slot)),
        ).reduce((a, b) => a && b);
    }

    private async validateMultiAssetsBalance(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
    ): Promise<boolean> {
        const keyDeposit = BigInt(genesis.protocolParams.keyDeposit);
        const poolDeposit = BigInt(genesis.protocolParams.poolDeposit);

        if (block.transactionBodies.length === 0) {
            return true; // No inputs to validate
        }

        // Collect all UTxO references that are inputs to transactions in this block
        const inputUtxoRefs = block.transactionBodies.map((txBody) =>
            txBody.inputs.map((input) =>
                `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
            )
        ).flat();

        // Query only the UTxOs that are inputs to this block with extracted amount
        const utxoRows = await getUtxosByRefs(inputUtxoRefs);

        // Create a lookup map for efficient access
        const utxoMap = new Map(
            utxoRows.map(
                (
                    { utxo_ref, amount },
                ) => [utxo_ref, { utxo_ref, amount: BigInt(amount) }],
            ),
        );

        for (const txBody of block.transactionBodies) {
            // Calculate input value (ADA + native assets)
            let inputValue = Value.zero;
            for (const input of txBody.inputs) {
                const utxoRef =
                    `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.error(`UTxO not found for input: ${utxoRef}`);
                    return false;
                }

                // Convert database format to Value
                const utxoValue = Value.lovelaces(row.amount);
                inputValue = Value.add(inputValue, utxoValue);
            }

            // Calculate output value
            let outputValue = Value.zero;
            for (const output of txBody.outputs) {
                outputValue = Value.add(outputValue, output.value);
            }

            // Add transaction fee
            outputValue = Value.add(outputValue, Value.lovelaces(txBody.fee));

            // Add certificate deposits
            let certDeposits = Value.zero;
            if (txBody.certs) {
                for (const cert of txBody.certs) {
                    if (
                        cert.certType === CertificateType.StakeRegistration ||
                        cert.certType === CertificateType.StakeDeRegistration
                    ) { // Stake key registration/deregistration
                        certDeposits = Value.add(
                            certDeposits,
                            Value.lovelaces(keyDeposit),
                        );
                    } else if (
                        cert.certType === CertificateType.PoolRegistration
                    ) { // Pool registration
                        certDeposits = Value.add(
                            certDeposits,
                            Value.lovelaces(poolDeposit),
                        );
                    }
                }
            }
            outputValue = Value.add(outputValue, certDeposits);

            // Subtract minting (which adds to the supply)
            if ("mint" in txBody && txBody.mint) {
                inputValue = Value.add(inputValue, txBody.mint);
            }

            // Add withdrawals (which are like additional inputs)
            if (txBody.withdrawals) {
                const withdrawalValue = txBody.withdrawals.toTotalWitdrawn();
                inputValue = Value.add(inputValue, withdrawalValue);
            }

            // Check that input value equals output value
            if (!Value.isZero(Value.sub(inputValue, outputValue))) {
                logger.error(`Multi-asset balance mismatch for transaction`);
                return false;
            }
        }

        return true;
    }

    private async validateCollateralValid(
        block: CardanoBlock,
    ): Promise<boolean> {
        // Use defaults for collateral params as they are not in Shelley genesis
        const collateralPercent = 150;
        const maxCollateralInputs = 3;

        // Collect all collateral UTxO references and validate in one pass
        const collateralUtxoRefs: string[] = [];

        for (const txBody of block.transactionBodies) {
            // Check if transaction has scripts (requires collateral) - only available in certain eras
            const hasScripts =
                ("scriptDataHash" in txBody && txBody.scriptDataHash) ||
                ("redeemers" in txBody && txBody.redeemers &&
                    (txBody.redeemers as any[]).length > 0);

            if (!hasScripts) continue; // No scripts, no collateral required

            // Validate collateral inputs exist and are sufficient - only available in certain eras
            const collateralInputs = (txBody as any).collateralInputs;
            if (!collateralInputs || collateralInputs.length === 0) {
                logger.error("Script transaction missing collateral inputs");
                return false;
            }

            if (collateralInputs.length > maxCollateralInputs) {
                logger.error(
                    `Too many collateral inputs: ${collateralInputs.length} > ${maxCollateralInputs}`,
                );
                return false;
            }

            // Collect collateral UTxO refs for batch query
            collateralUtxoRefs.push(
                ...collateralInputs.map((collateralInput: any) =>
                    `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`
                ),
            );
        }

        if (collateralUtxoRefs.length === 0) {
            return true; // No collateral to validate
        }

        // Query only the collateral UTxOs with extracted amount
        const utxoRows = await getUtxosByRefs(collateralUtxoRefs);

        // Create a lookup map for efficient access
        const utxoMap = new Map(
            utxoRows.map(
                (
                    { utxo_ref, amount },
                ) => [utxo_ref, { utxo_ref, amount: BigInt(amount) }],
            ),
        );

        // Re-process transactions for collateral validation
        let collateralIndex = 0;
        for (const txBody of block.transactionBodies) {
            const hasScripts =
                ("scriptDataHash" in txBody && txBody.scriptDataHash) ||
                ("redeemers" in txBody && txBody.redeemers &&
                    (txBody.redeemers as any[]).length > 0);

            if (!hasScripts) continue;

            const collateralInputs = (txBody as any).collateralInputs;

            // Calculate collateral value
            let collateralValue = 0n;
            for (const collateralInput of collateralInputs) {
                const utxoRef =
                    `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.error(`Collateral UTxO not found: ${utxoRef}`);
                    return false;
                }

                collateralValue += row.amount;
            }

            // Check collateral covers required amount (fee * collateralPercent / 100)
            const requiredCollateral =
                (txBody.fee * BigInt(collateralPercent)) /
                100n;
            if (collateralValue < requiredCollateral) {
                logger.error(
                    `Insufficient collateral: ${collateralValue} < ${requiredCollateral}`,
                );
                return false;
            }

            // Validate collateral outputs (should return unused collateral) - only available in certain eras
            if ("collateralReturn" in txBody && txBody.collateralReturn) {
                // Additional validation could check that collateral return is properly formatted
            }
        }

        return true;
    }

    private async validateCertificatesValid(
        block: CardanoBlock,
    ): Promise<boolean> {
        // Query current stake distribution and delegations
        const stakeRows = await getAllStake();
        const delegationRows = await getAllDelegations();

        // Create lookup maps with string keys for reliable comparison
        const getKey = (cred: Uint8Array | string) =>
            typeof cred === "string" ? cred : toHex(cred);
        const stakeMap = new Map(
            stakeRows.map((
                { stake_credentials, amount },
            ) => [getKey(stake_credentials), amount]),
        );
        const delegationMap = new Map(
            delegationRows.map((
                { stake_credentials, pool_key_hash },
            ) => [getKey(stake_credentials), pool_key_hash]),
        );

        for (const txBody of block.transactionBodies) {
            if (!txBody.certs) continue;

            for (const cert of txBody.certs) {
                switch (cert.certType) {
                    case CertificateType.StakeRegistration:
                        // Check if stake key is not already registered
                        const stakeKeyReg = toHex(
                            cert.stakeCredential.hash.toBuffer(),
                        );
                        if (stakeMap.has(stakeKeyReg)) {
                            logger.error(
                                `Stake key already registered: ${stakeKeyReg}`,
                            );
                            return false;
                        }
                        break;

                    case CertificateType.StakeDeRegistration:
                        // Check if stake key is registered
                        const stakeKeyDereg = toHex(
                            cert.stakeCredential.hash.toBuffer(),
                        );
                        if (!stakeMap.has(stakeKeyDereg)) {
                            logger.error(
                                `Stake key not registered: ${stakeKeyDereg}`,
                            );
                            return false;
                        }
                        break;

                    case CertificateType.StakeDelegation:
                        // Check if stake key exists (either registered or delegating)
                        const stakeKeyDel = toHex(
                            cert.stakeCredential.hash.toBuffer(),
                        );
                        if (
                            !stakeMap.has(stakeKeyDel) &&
                            !delegationMap.has(stakeKeyDel)
                        ) {
                            logger.error(
                                `Cannot delegate unregistered stake key: ${stakeKeyDel}`,
                            );
                            return false;
                        }
                        break;

                    case CertificateType.PoolRegistration:
                        // Pool registration is generally allowed (pool ID uniqueness checked elsewhere)
                        break;

                    case CertificateType.PoolRetirement:
                        // Check if pool exists (would need pool data)
                        break;

                    default:
                        logger.error(
                            `Unknown certificate type: ${cert.certType}`,
                        );
                        return false;
                }
            }
        }

        return true;
    }

    private validateScriptsValid(
        block: CardanoBlock,
    ): boolean {
        // Basic script validation - check that script data and redeemers are consistent
        for (const txBody of block.transactionBodies) {
            // If transaction has redeemers, it must have script data hash (only in certain eras)
            if (
                "redeemers" in txBody && txBody.redeemers &&
                (txBody.redeemers as any[]).length > 0
            ) {
                if (!("scriptDataHash" in txBody) || !txBody.scriptDataHash) {
                    logger.error(
                        "Transaction has redeemers but no script data hash",
                    );
                    return false;
                }
            }

            // If transaction has script data hash, validate it corresponds to actual scripts (only in certain eras)
            if ("scriptDataHash" in txBody && txBody.scriptDataHash) {
                // This would require validating that the script data hash matches
                // the actual script data, but that's complex without full script execution
                logger.log(
                    "Script data hash present - full validation requires script execution",
                );
            }

            // Check that witness set has corresponding scripts for redeemers (only in certain eras)
            if (
                block.transactionWitnessSets && "redeemers" in txBody &&
                txBody.redeemers && (txBody.redeemers as any[]).length > 0
            ) {
                const txIndex = block.transactionBodies.indexOf(txBody as any);
                if (
                    txIndex >= 0 &&
                    txIndex < block.transactionWitnessSets.length
                ) {
                    const witnessSet = block.transactionWitnessSets[txIndex];
                    if (
                        witnessSet &&
                        (!("scripts" in witnessSet) || !witnessSet.scripts ||
                            (witnessSet.scripts as any[]).length === 0)
                    ) {
                        logger.error(
                            "Transaction has redeemers but no scripts in witness set",
                        );
                        return false;
                    }
                }
            }
        }

        // Note: Full Plutus script execution validation would require:
        // 1. UTxO resolution for script inputs
        // 2. Datum resolution
        // 3. Redeemer application
        // 4. Script execution with proper context
        // This is a complex implementation that would require a full Plutus evaluator

        return true;
    }

    private async validateSizeLimits(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
    ): Promise<boolean> {
        const maxTxSize = genesis.protocolParams.maxTxSize;

        return block.transactionBodies.every((txBody: any) => {
            const txSize = txBody.toCborBytes().length;
            const isValid = txSize <= maxTxSize;

            if (!isValid) {
                logger.error(
                    `Transaction size ${txSize} exceeds maximum ${maxTxSize}`,
                );
            }

            return isValid;
        });
    }
}

export async function validateBlock(
    block: MultiEraBlock,
    config: any,
): Promise<boolean> {
    const validator = new BlockBodyValidator(config);
    return await validator.validate(block) ?? false;
}
