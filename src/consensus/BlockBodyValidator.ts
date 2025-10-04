import {
    MultiEraBlock,
    TxOutRef,
    Value,
} from "@harmoniclabs/cardano-ledger-ts";
import { IReadWriteNES } from "../types";
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
    // TODO: Figure out how to implement Phase-2 script validation
    //
    return true;
}

function validateUTxOBalance(
    block: any,
    _state: RawNewEpochState,
): boolean {
    let sumInputs = Value.zero;
    let sumOutputs = Value.zero;
    let sumFees = Value.zero;
    let sumDeposits = Value.zero;

    for (const txBody of block.transactionBodies) {
        sumInputs = Value.add(
            sumInputs,
            txBody.inputs.map((utxo) => utxo.resolved.value)
                .reduce((a, b) => Value.add(a, b)),
        );
        sumOutputs = Value.add(
            sumOutputs,
            txBody.outputs.map((utxo) => utxo.value).reduce((a, b) =>
                Value.add(a, b)
            ),
        );
        sumFees = Value.add(
            sumFees,
            Value.lovelaces(txBody.fee),
        );
        sumDeposits = Value.add(
            sumDeposits,
            Value.lovelaces(txBody.totCollateral ?? 0),
        );
    }

    return sumInputs.lovelaces >=
        [sumOutputs, sumFees, sumDeposits].reduce((a, b) => Value.add(a, b))
            .lovelaces;
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
    // Implementation
    return false;
}

function validateCertificatesValid(
    block: any,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
}

function validateScriptsValid(
    block: any,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
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
