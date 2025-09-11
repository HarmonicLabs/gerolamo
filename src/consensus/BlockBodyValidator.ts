import { BabbageBlock, TxOutRef, Value } from "@harmoniclabs/cardano-ledger-ts";
import { IReadWriteNES } from "../types";
import { MockChainState } from "./validation";
import { RawNewEpochState } from "../rawNES";

export function validateBlock(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    return [
        validateTransactionCountMatch(block, state),
        validateNoInvalidTxs(block, state),
        validateUTxOBalance(block, state),
        validateFeesCorrect(block, state),
        validateValidityInterval(block, state),
        validateMultiAssetsBalance(block, state),
        validateCollateralValid(block, state),
        validateCertificatesValid(block, state),
        validateScriptsValid(block, state),
        validateSizeLimits(block, state),
    ].reduce((a, b) => a && b, true);
}

function validateTransactionCountMatch(
    block: BabbageBlock,
    _state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.length ===
        block.transactionWitnessSets.length;
}

function validateNoInvalidTxs(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // TODO: Figure out how to implement Phase-2 script validation
    //
    return false;
}

function validateUTxOBalance(
    block: BabbageBlock,
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
                .reduce(Value.add),
        );
        sumOutputs = Value.add(
            sumOutputs,
            txBody.outputs.map((utxo) => utxo.value).reduce(Value.add),
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
        [sumOutputs, sumFees, sumDeposits].reduce(Value.add).lovelaces;
}

function validateFeesCorrect(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map((txBody) =>
        txBody.fee >=
            BigInt(MockChainState.protocol_parameters.txFeePerByte.valueOf()) * // min_fee_a
                        BigInt(txBody.toCborBytes().length) + // size
                BigInt(MockChainState.protocol_parameters.txFeeFixed) // min_fee_b
    ).reduce((a, b) => a && b);
}

function validateValidityInterval(
    block: BabbageBlock,
    _state: RawNewEpochState,
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

// TODO: Fill in placeholder for cert deposits
function validateMultiAssetsBalance(
    block: BabbageBlock,
    _state: RawNewEpochState,
): boolean {
    return block.transactionBodies.map((txBody) => {
        let inputValueMA = txBody.inputs.map((utxo) => utxo.resolved.value)
            .reduce(Value.add, Value.zero);
        let outputValueMA = txBody.outputs.map((txOut) => txOut.value).reduce(
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
    }).reduce((a, b) => a && b, true);
}

function validateCollateralValid(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
}

function validateCertificatesValid(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
}

function validateScriptsValid(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
}

function validateSizeLimits(
    block: BabbageBlock,
    state: RawNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map((txBody) =>
        txBody.toCborBytes().length <=
            MockChainState.protocol_parameters.maxTxSize
    ).reduce((a, b) => a && b);
}
