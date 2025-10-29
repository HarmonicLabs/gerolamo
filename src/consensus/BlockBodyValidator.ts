import {
    BabbageBlock,
    MultiEraBlock,
    Value,
} from "@harmoniclabs/cardano-ledger-ts";
import { SQLNewEpochState } from "./ledger";

export async function validateBlock(
    block: MultiEraBlock,
    state: SQLNewEpochState,
): Promise<boolean> {
    if (!block.block) return true; // Skip if block not parsed
    const babbageBlock = block.block as any;
    return (
        validateTransactionCountMatch(babbageBlock, state) &&
        validateNoInvalidTxs(babbageBlock, state) &&
        await validateUTxOBalance(babbageBlock, state) &&
        validateFeesCorrect(babbageBlock, state) &&
        validateValidityInterval(babbageBlock, state) &&
        validateMultiAssetsBalance(babbageBlock, state) &&
        validateCollateralValid(babbageBlock, state) &&
        validateCertificatesValid(babbageBlock, state) &&
        validateScriptsValid(babbageBlock, state) &&
        validateSizeLimits(babbageBlock, state)
    );
}

function validateTransactionCountMatch(
    block: any,
    _state: SQLNewEpochState,
): boolean {
    // Implementation
    if (!block.transactionBodies) return true; // Skip if not present
    return block.transactionBodies.length ===
        block.transactionWitnessSets.length;
}

function validateNoInvalidTxs(
    block: any,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement Phase-2 script validation
    // For now, assume all txs are valid
    return true;
}

async function validateUTxOBalance(
    block: any,
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
    block: any,
    state: SQLNewEpochState,
): boolean {
    // Implementation
    const minFeeA = 44; // from preprod genesis
    const minFeeB = 155381;
    return block.transactionBodies.map((txBody) =>
        txBody.fee >=
            BigInt(minFeeA) * BigInt(txBody.toCborBytes().length) +
                BigInt(minFeeB)
    ).reduce((a, b) => a && b);
}

function validateValidityInterval(
    block: any,
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
    block: any,
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
    block: any,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement collateral validation for Plutus scripts
    return true;
}

function validateCertificatesValid(
    block: any,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement certificate validation
    return true;
}

function validateScriptsValid(
    block: any,
    state: SQLNewEpochState,
): boolean {
    // TODO: Implement script validation
    return true;
}

function validateSizeLimits(
    block: any,
    state: SQLNewEpochState,
): boolean {
    // Implementation
    const maxTxSize = 16384; // from preprod genesis
    return block.transactionBodies.map((txBody) =>
        txBody.toCborBytes().length <= maxTxSize
    ).reduce((a, b) => a && b);
}
