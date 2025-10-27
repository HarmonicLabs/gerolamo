import { BabbageBlock, Value } from "@harmoniclabs/cardano-ledger-ts";
import { MockChainState } from "./validation";
import { SQLNewEpochState } from "./ledger";

export async function validateBlock(
    block: BabbageBlock,
    state: SQLNewEpochState,
): Promise<boolean> {
    return (
        validateTransactionCountMatch(block, state) &&
        validateNoInvalidTxs(block, state) &&
        await validateUTxOBalance(block, state) &&
        validateFeesCorrect(block, state) &&
        validateValidityInterval(block, state) &&
        validateMultiAssetsBalance(block, state) &&
        validateCollateralValid(block, state) &&
        validateCertificatesValid(block, state) &&
        validateScriptsValid(block, state) &&
        validateSizeLimits(block, state)
    );
}

function validateTransactionCountMatch(
    block: BabbageBlock,
    _state: SQLNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.length ===
        block.transactionWitnessSets.length;
}

function validateNoInvalidTxs(
    block: BabbageBlock,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement Phase-2 script validation
    // For now, assume all txs are valid
    return true;
}

async function validateUTxOBalance(
    block: BabbageBlock,
    state: SQLNewEpochState,
): Promise<boolean> {
    const utxos = await state.getUTxO();
    for (const txBody of block.transactionBodies) {
        let inputValue = 0n;
        for (const input of txBody.inputs) {
            const utxo = utxos.find((u) => u.utxoRef.eq(input.utxoRef));
            if (!utxo) return false;
            inputValue += utxo.resolved.value.lovelaces;
        }
        let outputValue = 0n;
        for (const output of txBody.outputs) {
            outputValue += output.value.lovelaces;
        }
        if (inputValue < outputValue + txBody.fee) return false;
    }
    return true;
}

function validateFeesCorrect(
    block: BabbageBlock,
    state: SQLNewEpochState,
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
    _state: SQLNewEpochState,
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
    _state: SQLNewEpochState,
): boolean {
    return block.transactionBodies.map((txBody) => {
        let inputValueMA = txBody.inputs.map((utxo) => utxo.resolved.value)
            .reduce((a, b) => Value.add(a, b), Value.zero);
        let outputValueMA = txBody.outputs.map((txOut) => txOut.value).reduce(
            (a, b) => Value.add(a, b),
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
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement collateral validation for Plutus scripts
    return true;
}

function validateCertificatesValid(
    block: BabbageBlock,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement certificate validation
    return true;
}

function validateScriptsValid(
    block: BabbageBlock,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement script validation
    return true;
}

function validateSizeLimits(
    block: BabbageBlock,
    state: SQLNewEpochState,
): boolean {
    // Implementation
    return block.transactionBodies.map((txBody) =>
        txBody.toCborBytes().length <=
            MockChainState.protocol_parameters.maxTxSize
    ).reduce((a, b) => a && b);
}
