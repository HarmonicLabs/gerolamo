import { MultiEraBlock, Value, ConwayBlock, BabbageBlock, AlonzoBlock, MaryBlock, AllegraBlock, ShelleyBlock, TxBody, TxOut, isShelleyProtocolParameters, defaultConwayProtocolParameters, CertificateType } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { defaultMaryProtocolParameters } from "../../reference/buildooor/src";

type CardanoBlock = ConwayBlock | BabbageBlock | AlonzoBlock | MaryBlock | AllegraBlock | ShelleyBlock;

export async function validateBlock(
    block: MultiEraBlock,
): Promise<boolean> {
    if (!block.block) return true; // Skip if block not parsed
    const actualBlock = block.block;
    return (
        validateTransactionCountMatch(actualBlock) &&
        validateNoInvalidTxs(actualBlock) &&
        await validateUTxOBalance(actualBlock) &&
        await validateFeesCorrect(actualBlock) &&
        validateValidityInterval(actualBlock) &&
        await validateMultiAssetsBalance(actualBlock) &&
        await validateCollateralValid(actualBlock) &&
        await validateCertificatesValid(actualBlock) &&
        validateScriptsValid(actualBlock) &&
        await validateSizeLimits(actualBlock)
    );
}

function validateTransactionCountMatch(
    block: CardanoBlock,
): boolean {
    // Implementation
    if (!block.transactionBodies) return true; // Skip if not present
    return block.transactionBodies.length ===
        block.transactionWitnessSets.length;
}

function validateNoInvalidTxs(
    _block: CardanoBlock,
): boolean {
    // TODO: Implement Phase-2 script validation
    // For now, assume all txs are valid
    return true;
}

async function validateUTxOBalance(
    block: CardanoBlock,
): Promise<boolean> {
    // Collect all UTxO references that are inputs to transactions in this block
    if (block.transactionBodies.length === 0) {
        return true; // No inputs to validate
    }

    const inputUtxoRefs = block.transactionBodies.map(
        (txBody) => txBody.inputs.map(
            (input) => `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
        )
    ).flat();

    // Query only the UTxOs that are inputs to this block
    const utxoRows = await sql`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN ${sql(inputUtxoRefs)}`.values() as [string, string][];

    // Create a lookup map for efficient access
    const utxoMap = new Map(utxoRows.map(([utxo_ref, tx_out]) => [utxo_ref, { utxo_ref, tx_out }]));

    for (const txBody of block.transactionBodies) {
        let inputValue = 0n;

        // Validate each input exists and accumulate input value
        for (const input of txBody.inputs) {
            const utxoRef = `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

            const row = utxoMap.get(utxoRef);
            if (!row) {
                console.error(`UTxO not found: ${utxoRef}`);
                return false;
            }

            const txOut = JSON.parse(row.tx_out);
            inputValue += BigInt(txOut.amount);
        }

        // Calculate output value
        let outputValue = 0n;
        for (const output of txBody.outputs) {
            outputValue += output.value.lovelaces;
        }

        // Check that inputs cover outputs + fee
        if (inputValue < outputValue + txBody.fee) {
            console.error(`Insufficient input value for transaction: ${inputValue} < ${outputValue} + ${txBody.fee}`);
            return false;
        }
    }

    return true;
}

async function validateFeesCorrect(
    block: CardanoBlock,
): Promise<boolean> {
    // Query protocol parameters from database
    const protocolParamsResult = await sql`SELECT params FROM protocol_params WHERE id = 1`.values();
    if (protocolParamsResult.length === 0) {
        console.error("Protocol parameters not found in database");
        return false;
    }

    const params = JSON.parse(protocolParamsResult[0].params);
    const minFeeA = params.minFeeA || params.min_fee_a || 44;
    const minFeeB = params.minFeeB || params.min_fee_b || 155381;

    return block.transactionBodies.every((txBody: any) => {
        const txSize = txBody.toCborBytes().length;
        const calculatedFee = BigInt(minFeeA) * BigInt(txSize) + BigInt(minFeeB);
        const isValid = txBody.fee >= calculatedFee;

        if (!isValid) {
            console.error(`Invalid fee for transaction: expected >= ${calculatedFee}, got ${txBody.fee}`);
        }

        return isValid;
    });
}

function validateValidityInterval(
    block: CardanoBlock,
): boolean {
    // Implementation
    return block.transactionBodies.map(
        (txBody) =>
            (txBody.validityIntervalStart === undefined ||
                txBody.validityIntervalStart! <= block.header.body.slot) &&
            (txBody.ttl === undefined ||
                txBody.validityIntervalStart! + txBody.ttl! >
                    block.header.body.slot),
    ).reduce((a, b) => a && b);
}

async function validateMultiAssetsBalance(
    block: CardanoBlock,
): Promise<boolean> {
    // Query protocol parameters for deposit amounts
    const protocolParamsResult = await sql`SELECT params FROM protocol_params WHERE id = 1`.values();
    if (protocolParamsResult.length === 0) {
        console.error("Protocol parameters not found in database");
        return false;
    }

    const params = JSON.parse(protocolParamsResult[0].params);
    const keyDeposit = BigInt(params.keyDeposit || params.key_deposit || 2000000);
    const poolDeposit = BigInt(params.poolDeposit || params.pool_deposit || 500000000);

    if (block.transactionBodies.length === 0) {
        return true; // No inputs to validate
    }

    // Collect all UTxO references that are inputs to transactions in this block
    const inputUtxoRefs = block.transactionBodies.map((txBody) => txBody.map((input) =>
        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
    )).flat();

    // Query only the UTxOs that are inputs to this block
    const utxoRows = await sql`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN ${sql(inputUtxoRefs)}`.values() as [string, string][];

    // Create a lookup map for efficient access
    const utxoMap = new Map(utxoRows.map(([utxo_ref, tx_out]) => [utxo_ref, { utxo_ref, tx_out }]));

    for (const txBody of block.transactionBodies) {
        // Calculate input value (ADA + native assets)
        let inputValue = Value.zero;
        for (const input of txBody.inputs) {
            const utxoRef = `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

            const row = utxoMap.get(utxoRef);
            if (!row) {
                console.error(`UTxO not found for input: ${utxoRef}`);
                return false;
            }

            const txOut = JSON.parse(row.tx_out);
            // Convert database format to Value
            const utxoValue = Value.lovelaces(BigInt(txOut.amount));
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
                if (cert.certType === CertificateType.StakeRegistration || cert.certType === CertificateType.StakeDeRegistration) { // Stake key registration/deregistration
                    certDeposits = Value.add(certDeposits, Value.lovelaces(keyDeposit));
                } else if (cert.certType === CertificateType.PoolRegistration) { // Pool registration
                    certDeposits = Value.add(certDeposits, Value.lovelaces(poolDeposit));
                }
            }
        }
        outputValue = Value.add(outputValue, certDeposits);

        // Subtract minting (which adds to the supply)
        if ('mint' in txBody && txBody.mint) {
            inputValue = Value.add(inputValue, txBody.mint);
        }

        // Add withdrawals (which are like additional inputs)
        if (txBody.withdrawals) {
            const withdrawalValue = txBody.withdrawals.toTotalWitdrawn();
            inputValue = Value.add(inputValue, withdrawalValue);
        }

        // Check that input value equals output value
        if (!Value.isZero(Value.sub(inputValue, outputValue))) {
            console.error(`Multi-asset balance mismatch for transaction`);
            return false;
        }
    }

    return true;
}

async function validateCollateralValid(
    block: CardanoBlock,
): Promise<boolean> {
    // Query protocol parameters for collateral requirements
    const protocolParamsResult = await sql`SELECT params FROM protocol_params WHERE id = 1`.values();
    if (protocolParamsResult.length === 0) {
        console.error("Protocol parameters not found in database");
        return false;
    }

    const params = JSON.parse(protocolParamsResult[0].params);
    const collateralPercent = params.collateralPercent || params.collateral_percent || 150; // 150%
    const maxCollateralInputs = params.maxCollateralInputs || params.max_collateral_inputs || 3;

    // Collect all collateral UTxO references and validate in one pass
    const collateralUtxoRefs: string[] = [];

    for (const txBody of block.transactionBodies) {
        // Check if transaction has scripts (requires collateral) - only available in certain eras
        const hasScripts = ('scriptDataHash' in txBody && txBody.scriptDataHash) ||
                          ('redeemers' in txBody && txBody.redeemers && (txBody.redeemers as any[]).length > 0);

        if (!hasScripts) continue; // No scripts, no collateral required

        // Validate collateral inputs exist and are sufficient - only available in certain eras
        const collateralInputs = (txBody as any).collateralInputs;
        if (!collateralInputs || collateralInputs.length === 0) {
            console.error("Script transaction missing collateral inputs");
            return false;
        }

        if (collateralInputs.length > maxCollateralInputs) {
            console.error(`Too many collateral inputs: ${collateralInputs.length} > ${maxCollateralInputs}`);
            return false;
        }

        // Collect collateral UTxO refs for batch query
        for (const collateralInput of collateralInputs) {
            const utxoRef = `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`;
            collateralUtxoRefs.push(utxoRef);
        }
    }

    if (collateralUtxoRefs.length === 0) {
        return true; // No collateral to validate
    }

    // Query only the collateral UTxOs
    const utxoRows = await sql`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN ${sql(collateralUtxoRefs)}`.values() as [string, string][];

    // Create a lookup map for efficient access
    const utxoMap = new Map(utxoRows.map(([utxo_ref, tx_out]) => [utxo_ref, { utxo_ref, tx_out }]));

    // Re-process transactions for collateral validation
    let collateralIndex = 0;
    for (const txBody of block.transactionBodies) {
        const hasScripts = ('scriptDataHash' in txBody && txBody.scriptDataHash) ||
                          ('redeemers' in txBody && txBody.redeemers && (txBody.redeemers as any[]).length > 0);

        if (!hasScripts) continue;

        const collateralInputs = (txBody as any).collateralInputs;

        // Calculate collateral value
        let collateralValue = 0n;
        for (const collateralInput of collateralInputs) {
            const utxoRef = `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`;

            const row = utxoMap.get(utxoRef);
            if (!row) {
                console.error(`Collateral UTxO not found: ${utxoRef}`);
                return false;
            }

            const txOut = JSON.parse(row.tx_out);
            collateralValue += BigInt(txOut.amount);
        }

        // Check collateral covers required amount (fee * collateralPercent / 100)
        const requiredCollateral = (txBody.fee * BigInt(collateralPercent)) / 100n;
        if (collateralValue < requiredCollateral) {
            console.error(`Insufficient collateral: ${collateralValue} < ${requiredCollateral}`);
            return false;
        }

        // Validate collateral outputs (should return unused collateral) - only available in certain eras
        if ('collateralReturn' in txBody && txBody.collateralReturn) {
            // Additional validation could check that collateral return is properly formatted
        }
    }

    return true;
}

async function validateCertificatesValid(
    block: CardanoBlock,
): Promise<boolean> {
    // Query current stake distribution and delegations
    const stakeRows: [string, any][] = await sql`SELECT * FROM stake`.values();
    const delegationRows: [string, any][] = await sql`SELECT * FROM delegations`.values();

    // Create lookup maps
    const stakeMap = new Map(stakeRows);
    const delegationMap = new Map(delegationRows);

    for (const txBody of block.transactionBodies) {
        if (!txBody.certs) continue;

        for (const cert of txBody.certs) {
            switch (cert.certType) {
                case CertificateType.StakeRegistration:
                    // Check if stake key is not already registered
                    if (stakeMap.has(cert.stakeCredential.hash.toString())) {
                        console.error(`Stake key already registered: ${cert.stakeCredential.hash}`);
                        return false;
                    }
                    break;

                case CertificateType.StakeDeRegistration:
                    // Check if stake key is registered
                    if (!stakeMap.has(cert.stakeCredential.hash.toString())) {
                        console.error(`Stake key not registered: ${cert.stakeCredential.hash}`);
                        return false;
                    }
                    break;

                case CertificateType.StakeDelegation:
                    // Check if stake key exists (either registered or delegating)
                    const stakeKey = cert.stakeCredential.hash.toString();
                    if (!stakeMap.has(stakeKey) && !delegationMap.has(stakeKey)) {
                        console.error(`Cannot delegate unregistered stake key: ${stakeKey}`);
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
                    console.error(`Unknown certificate type: ${cert.certType}`);
                    return false;
            }
        }
    }

    return true;
}

function validateScriptsValid(
    block: CardanoBlock,
): boolean {
    // Basic script validation - check that script data and redeemers are consistent
    for (const txBody of block.transactionBodies) {
        // If transaction has redeemers, it must have script data hash (only in certain eras)
        if ('redeemers' in txBody && txBody.redeemers && (txBody.redeemers as any[]).length > 0) {
            if (!('scriptDataHash' in txBody) || !txBody.scriptDataHash) {
                console.error("Transaction has redeemers but no script data hash");
                return false;
            }
        }

        // If transaction has script data hash, validate it corresponds to actual scripts (only in certain eras)
        if ('scriptDataHash' in txBody && txBody.scriptDataHash) {
            // This would require validating that the script data hash matches
            // the actual script data, but that's complex without full script execution
            console.log("Script data hash present - full validation requires script execution");
        }

        // Check that witness set has corresponding scripts for redeemers (only in certain eras)
        if (block.transactionWitnessSets && 'redeemers' in txBody && txBody.redeemers && (txBody.redeemers as any[]).length > 0) {
            const txIndex = block.transactionBodies.indexOf(txBody as any);
            if (txIndex >= 0 && txIndex < block.transactionWitnessSets.length) {
                const witnessSet = block.transactionWitnessSets[txIndex];
                if (witnessSet && (!('scripts' in witnessSet) || !witnessSet.scripts || (witnessSet.scripts as any[]).length === 0)) {
                    console.error("Transaction has redeemers but no scripts in witness set");
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

async function validateSizeLimits(
    block: CardanoBlock,
): Promise<boolean> {
    // Query protocol parameters from database
    const protocolParamsResult = await sql`SELECT params FROM protocol_params WHERE id = 1`.values();
    if (protocolParamsResult.length === 0) {
        console.error("Protocol parameters not found in database");
        return false;
    }

    const params = JSON.parse(protocolParamsResult[0].params);
    const maxTxSize = params.maxTxSize || params.max_tx_size || 16384;

    return block.transactionBodies.every((txBody: any) => {
        const txSize = txBody.toCborBytes().length;
        const isValid = txSize <= maxTxSize;

        if (!isValid) {
            console.error(`Transaction size ${txSize} exceeds maximum ${maxTxSize}`);
        }

        return isValid;
    });
}
