import {
    MultiEraBlock,
    TxOutRef,
    Value,
} from "@harmoniclabs/cardano-ledger-ts";
import { MockChainState } from "./validation";
import { RawNewEpochState } from "../rawNES";

export function validateBlock(
    block: MultiEraBlock,
    state: RawNewEpochState,
): boolean {
    // For now, assume all blocks are Babbage-era or later (era 6+) for validation
    // This can be extended to handle different eras
    if (block.era < 6) {
        throw new Error(
            `Unsupported era: ${block.era}. Block body validation currently supports Babbage-era (era 6) and later blocks.`,
        );
    }

    const actualBlock = block.block;
    return [
        validateTransactionCountMatch(actualBlock, state),
        validateNoInvalidTxs(actualBlock, state),
        validateUTxOBalance(actualBlock, state),
        validateFeesCorrect(actualBlock, state),
        validateValidityInterval(actualBlock, state),
        validateMultiAssetsBalance(actualBlock, state),
        validateCollateralValid(actualBlock, state),
        validateCertificatesValid(actualBlock, state),
        validateScriptsValid(actualBlock, state),
        validateSizeLimits(actualBlock, state),
    ].reduce((a, b) => a && b, true);
}

function validateTransactionCountMatch(
    block: any,
    _state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.length ===
        block.transactionWitnessSets.length;
}

function validateNoInvalidTxs(
    block: any,
    state: RawNewEpochState,
): boolean {
    // For chain following, trust network consensus for Phase-2 script validation
    // In full implementation, would execute Plutus scripts
    return true;
}

function validateUTxOBalance(
    block: any,
    state: RawNewEpochState,
): boolean {
    for (const txBody of block.transactionBodies) {
        let sumInputs = Value.zero;
        let sumOutputs = Value.zero;
        let sumFees = Value.zero;
        let sumDeposits = Value.zero;

        // Resolve input values from UTxO set
        for (const input of txBody.inputs) {
            const utxo = state.epochState.ledgerState.UTxOState.UTxO.find(
                (u) => u.utxoRef.eq(input.utxoRef)
            );
            if (!utxo) return false; // Input doesn't exist
            sumInputs = Value.add(sumInputs, utxo.resolved.value);
        }

        sumOutputs = txBody.outputs.reduce((acc, output) =>
            Value.add(acc, output.value), Value.zero);

        sumFees = Value.lovelaces(txBody.fee);

        // For deposits, we need to calculate based on certificates
        // This is a simplified version - in full implementation, calculate net deposits
        sumDeposits = Value.zero; // Placeholder

        if (sumInputs.lovelaces < sumOutputs.lovelaces + sumFees.lovelaces + sumDeposits.lovelaces) {
            return false;
        }
    }
    return true;
}

function validateFeesCorrect(
    block: any,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map((txBody: any) =>
        txBody.fee >=
            BigInt(MockChainState.protocol_parameters.txFeePerByte.valueOf()) * // min_fee_a
                        BigInt(txBody.toCborBytes().length) + // size
                BigInt(MockChainState.protocol_parameters.txFeeFixed) // min_fee_b
    ).reduce((a: boolean, b: boolean) => a && b);
}

function validateValidityInterval(
    block: any,
    _state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map(
        (txBody: any) =>
            (txBody.validityIntervalStart === undefined ||
                txBody.validityIntervalStart! <= block.header.body.slot) &&
            (txBody.ttl === undefined ||
                txBody.validityIntervalStart! + txBody.ttl! >
                    block.header.body.slot),
    ).reduce((a: boolean, b: boolean) => a && b);
}

// TODO: Fill in placeholder for cert deposits
function validateMultiAssetsBalance(
    block: any,
    _state: RawNewEpochState,
): boolean {
    return block.transactionBodies.map((txBody: any) => {
        let inputValueMA = txBody.inputs.map((utxo: any) => utxo.resolved.value)
            .reduce(Value.add, Value.zero);
        let outputValueMA = txBody.outputs.map((txOut: any) => txOut.value)
            .reduce(
                Value.add,
                Value.zero,
            );

        return Value.isZero(
            Value.sub(
                Value.add(
                    outputValueMA,
                    Value.add(
                        Value.lovelaces(txBody.fee),
                        Value.zero, /*Placeholder for cert deposits*/
                    ),
                ),
                Value.sub(
                    Value.add(inputValueMA, txBody.mint ?? Value.zero),
                    txBody.withdrawals
                        ? txBody.withdrawals!.toTotalWitdrawn()
                        : Value.zero,
                ),
            ),
        );
    }).reduce((a: boolean, b: boolean) => a && b, true);
}

function validateCollateralValid(
    block: any,
    state: RawNewEpochState,
): boolean {
    for (const txBody of block.transactionBodies) {
        // Check if transaction has scripts (Phase-2)
        const hasScripts = txBody.inputs.some(input => {
            const utxo = state.epochState.ledgerState.UTxOState.UTxO.find(
                u => u.utxoRef.eq(input.utxoRef)
            );
            return utxo && utxo.resolved.datum !== undefined; // Simplified check for scripts
        }) || txBody.mint || txBody.certs?.some(cert => cert.certType > 10); // Rough check

        if (!hasScripts) continue; // No collateral required

        // Must have collateral inputs
        if (!txBody.collateral || txBody.collateral.length === 0) return false;

        // Collateral inputs must exist and contain only ADA
        let collateralSum = 0n;
        for (const collInput of txBody.collateral) {
            const utxo = state.epochState.ledgerState.UTxOState.UTxO.find(
                u => u.utxoRef.eq(collInput.utxoRef)
            );
            if (!utxo) return false;
            // Check if has multi-assets (simplified)
            if (utxo.resolved.value.map.some(entry => 'policy' in entry)) return false;
            collateralSum += utxo.resolved.value.lovelaces;
        }

        // Collateral must cover at least collateral_percent of fee
        const collateralPercent = 150; // Default from protocol params
        const requiredCollateral = txBody.fee * BigInt(collateralPercent) / 100n;
        if (collateralSum < requiredCollateral) return false;

        // Collateral return must be valid
        if (txBody.collateralReturn && txBody.collateralReturn.value.assets.size > 0) return false;
    }
    return true;
}

function validateCertificatesValid(
    block: any,
    state: RawNewEpochState,
): boolean {
    for (const txBody of block.transactionBodies) {
        if (!txBody.certs) continue;

        for (const cert of txBody.certs) {
            switch (cert.certType) {
                case 0: // StakeRegistration (deprecated)
                case 1: // StakeDeRegistration (deprecated)
                case 2: // StakeDelegation
                    // Basic checks
                    if (!cert.stakeCredential) return false;
                    break;
                case 3: // PoolRegistration
                    const poolReg = cert;
                    if (!poolReg.poolParams || !poolReg.poolParams.pledge ||
                        poolReg.poolParams.pledge < 0n) return false;
                    break;
                case 4: // PoolRetirement
                    // Basic checks
                    break;
                case 5: // GenesisKeyDelegation (deprecated)
                    break;
                case 6: // MoveInstantRewards (deprecated)
                    break;
                case 7: // RegistrationDeposit
                    if (!cert.stakeCredential || !cert.deposit || cert.deposit <= 0n) return false;
                    break;
                case 8: // UnRegistrationDeposit
                    if (!cert.stakeCredential || !cert.deposit || cert.deposit <= 0n) return false;
                    break;
                case 9: // VoteDeleg
                    break;
                case 10: // StakeVoteDeleg
                    break;
                case 11: // StakeRegistrationDeleg
                    if (!cert.stakeCredential || !cert.poolKeyHash || !cert.coin || cert.coin <= 0n) return false;
                    break;
                case 12: // VoteRegistrationDeleg
                    break;
                case 13: // StakeVoteRegistrationDeleg
                    if (!cert.stakeCredential || !cert.poolKeyHash || !cert.dRep || !cert.coin || cert.coin <= 0n) return false;
                    break;
                case 14: // AuthCommitteeHot
                    break;
                case 15: // ResignCommitteeCold
                    break;
                case 16: // RegistrationDrep
                    break;
                case 17: // UnRegistrationDrep
                    break;
                case 18: // UpdateDrep
                    break;
                default:
                    return false; // Unknown certificate type
            }
        }
    }
    return true;
}

function validateScriptsValid(
    block: any,
    state: RawNewEpochState,
): boolean {
    // For chain following, trust network consensus for script validation
    // In full implementation, would validate Phase-1 scripts (timelock/multisig)
    return true;
}

function validateSizeLimits(
    block: any,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map((txBody: any) =>
        txBody.toCborBytes().length <=
            MockChainState.protocol_parameters.maxTxSize
    ).reduce((a: boolean, b: boolean) => a && b);
}
