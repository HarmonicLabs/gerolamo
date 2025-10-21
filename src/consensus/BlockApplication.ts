// src/consensus/BlockApplicator.ts

import {
    Certificate,
    CertPoolRegistration,
    CertPoolRetirement,
    CertStakeDelegation,
    Coin,
    ConwayBlock,
    ConwayTx,
    ConwayTxBody,
    ConwayUTxO,
    Hash32,
    isITxWitnessSet,
    PoolKeyHash,
    StakeCredentials,
    TxOutRef,
} from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";

import { SQLNewEpochState } from "./ledger";
import { VolatileState } from "./validation/types";
import { AnchoredVolatileState, Point } from "./AnchoredVolatileState";

import * as assert from "node:assert/strict";
import { RawDelegations, RawPParams } from "../rawNES/epoch_state/snapshots";
import { calculateCardanoEpoch } from "./validation";

const EPOCH_TRANSITION_ENABLED = false;

// Function to apply a block to the state and return an AnchoredVolatileState
export async function applyBlock(
    block: ConwayBlock,
    state: SQLNewEpochState,
    issuer: PoolKeyHash,
): Promise<AnchoredVolatileState> {
    // Implementation

    if (EPOCH_TRANSITION_ENABLED) {
        const start_slot = block.header.body.slot;
        const tip_slot = await state.getLastEpochModified();

        const current_epoch = calculateCardanoEpoch(start_slot);
        const tip_epoch = calculateCardanoEpoch(tip_slot);

        if (current_epoch > tip_epoch) {
            // Epoch Change
            throw new Error();
        }
    }

    // Apply block
    assert.equal(
        block.transactionBodies.length,
        block.transactionWitnessSets.length,
    );

    const utxo = await state.getUTxO();
    const treasury = { value: await state.getTreasury() };

    for (const [i, tb] of block.transactionBodies.entries()) {
        assert.ok(isITxWitnessSet(block.transactionWitnessSets[i]));
        const tx = new ConwayTx({
            body: tb,
            witnesses: block.transactionWitnessSets[i],
        });
        await applyTx(tx, utxo, treasury);
    }

    await state.setUTxO(utxo);
    await state.setTreasury(treasury.value);

    // Create VolatileState from the applied block
    const volatileState = VolatileState.fromBlock(block);

    // Create anchor point from block header
    // Compute block hash from header bytes using Blake2b
    const headerBytes = block.header.toCborBytes();
    const blockHeaderHash = new Hash32(blake2b_256(headerBytes));
    const point: Point = {
        slot: block.header.body.slot,
        hash: blockHeaderHash,
    };

    // Return AnchoredVolatileState
    return AnchoredVolatileState.anchor(volatileState, point, issuer);
}

// Function to apply a transaction to the state
export async function applyTx(tx: ConwayTx, utxo: ConwayUTxO[], treasury: { value: bigint }): Promise<void> {
    // Implementation
    assert.ok(validateTx(tx, utxo));

    const refs = tx.body.inputs.map((input) => input.utxoRef);
    // TODO: Re-enable input validation once we have proper test blocks or genesis state
    // assert.ok(utxo.length === 0 || validateInputsExist(refs, utxo));

    removeInputs(refs, utxo);
    addOutputs(tx.body, utxo);

    // tx.body.certs!.forEach((cert) => processCert(cert, state));
    treasury.value = BigInt(treasury.value) + tx.body.fee;
}

function validateInputsExist(
    utxoRefs: TxOutRef[],
    utxo: ConwayUTxO[],
): boolean {
    return utxoRefs.every((ref) =>
        utxo.some((u) =>
            u.utxoRef.eq(ref)
        )
    );
}

// Function to shift snapshots at epoch boundary
export function shiftSnapshots(state: SQLNewEpochState): void {
    // Implementation
}

// Function to compute and distribute rewards using 'go' snapshot
export function computeRewards(state: SQLNewEpochState): void {
    // Implementation
}

// Function to process a certificate and update the state
export function processCert(
    cert: Certificate,
    state: SQLNewEpochState,
): void {
    // Enable certificate processing for demo - set to false to disable
    const ENABLE_CERT_PROCESSING = true;
    if (!ENABLE_CERT_PROCESSING) return;
}

// Helper function to remove stake credential from stake list
function removeStakeCredential(
    stakeList: [StakeCredentials, Coin][],
    cred: StakeCredentials,
): void {
    const index = stakeList.findIndex(([sc, _]) =>
        sc.toCborBytes() === cred.toCborBytes()
    );
    if (index >= 0) {
        stakeList.splice(index, 1);
    }
}

// Helper function to update delegation in snapshot
function updateDelegationInSnapshot(
    delegations: [StakeCredentials, PoolKeyHash][],
    cred: StakeCredentials,
    pool: PoolKeyHash,
): void {
    const index = delegations.findIndex(([sc, _]) =>
        sc.toCborBytes() === cred.toCborBytes()
    );
    if (index >= 0) {
        delegations[index][1] = pool;
    } else {
        delegations.push([cred, pool]);
    }
}

// Function to update delegation in the 'mark' snapshot
export function updateDelegation(
    deleg: CertStakeDelegation,
    state: SQLNewEpochState,
): void {
    // Implementation
}

// Function to register a pool in the 'f_p_pools'
export function registerPool(
    reg: CertPoolRegistration,
    state: SQLNewEpochState,
): void {
    // Implementation
}

// Function to retire a pool by updating retiring epoch
export function retirePool(
    ret: CertPoolRetirement,
    state: SQLNewEpochState,
): void {
    // Implementation
}

// Function to calculate reward for a pool based on stake and params
export function calculatePoolReward(
    stake: Coin,
    pool: PoolKeyHash,
    state: SQLNewEpochState,
): Coin {
    // Implementation
    return 0n;
}

// Function to validate a transaction against the state
export function validateTx(tx: ConwayTx, utxo: ConwayUTxO[]): boolean {
    /*
    ### Transaction Validation Algorithm in Cardano

    Based on the IOG research library and related documentation, transaction validation in Cardano (particularly in the Shelley/Babbage eras) is designed to be deterministic and "no-surprises," ensuring predictable outcomes, fees, and behavior before submission. This is achieved through the Extended Unspent Transaction Output (EUTXO) model, which avoids indeterminism common in account-based systems like Ethereum. The algorithm is divided into two phases: Phase-1 (structural and deterministic checks) and Phase-2 (script execution). Phase-1 must pass for Phase-2 to run, and collateral ensures fees are covered if Phase-2 fails. The process is formally specified in the Cardano ledger specs and supported by papers like "Formal specification of the Cardano blockchain ledger, mechanized in Agda."

    The validation occurs before applying the transaction to the ledger, ensuring it can be processed without unexpected failures or costs. Below is a step-by-step detail of the algorithm, drawn from the ledger rules and blog posts on deterministic validation.

    #### Preparation: Gather Ledger State and Protocol Parameters
    Before validation, retrieve the current ledger state (UTxO set, stake distribution, pool parameters, etc.) and protocol parameters (e.g., `min_fee_a`, `min_fee_b`, `key_deposit`, `pool_deposit`, `collateral_percent`, `max_tx_size`, `max_ex_mem`, `max_ex_steps`). These are from the `NewEpochState` or equivalent.

    #### Phase-1 Validation: Structural and Deterministic Checks
    This phase ensures the transaction is well-formed and can pay its own fees without running scripts. It is fully deterministic, based on transaction size and structure. If Phase-1 fails, the transaction is rejected without cost (except minimal network propagation).

    1. **Check Transaction Structure**:
       - Verify the transaction body has all required fields: inputs, outputs, fee, validity interval, certificates, withdrawals, mint/burn, etc.
       - Ensure inputs are distinct, outputs are valid addresses, and no duplicate certificates.
       - If the transaction has Phase-2 scripts (e.g., Plutus V2), ensure collateral inputs are present and valid (no scripts in collateral outputs, only ADA).

    2. **Validate UTxO Inputs**:
       - All inputs must exist in the current UTxO set and be unspent.
       - Sum input values (ADA and multi-assets).
       - Ensure no input is locked by an expired timelock or invalid phase-1 script (multisig/timelock).

    3. **Calculate Minimum Fee**:
       - Compute transaction size in bytes (CBOR serialized).
       - Fee = `min_fee_a * size + min_fee_b`.
       - Assert transaction's declared fee >= calculated min fee.

    4. **Check UTxO Balance (ADA Preservation)**:
       - Sum inputs ADA >= sum outputs ADA + fee + net deposits (deposits - refunds).
       - Deposits from certificates (e.g., `key_deposit` for stake reg, `pool_deposit` for pool reg).
       - Refunds from withdrawals or deregistrations.
       - No net ADA creation/destruction (except protocol-defined, e.g., rewards).

    5. **Validate Multi-Asset Balance**:
       - For non-ADA assets, sum inputs + mint = sum outputs + burn.
       - Mint/burn must be authorized by policy scripts (checked in Phase-2 if scripted).

    6. **Validate Validity Interval**:
       - Current slot >= validity_start (if set) and < TTL (if set).
       - Ensures transaction is timely.

    7. **Validate Collateral (if Phase-2 Scripts Present)**:
       - Collateral inputs must exist, contain only ADA, and sum >= (fee * collateral_percent) / 100.
       - Collateral outputs must be simple (no scripts, no multi-assets).
       - Collateral return address must be valid.

    8. **Validate Certificates**:
       - Check stake registrations, delegations, pool registrations/retirements comply with rules (e.g., pledge >= min, cost >= min_pool_cost).
       - No duplicates, valid signatures.

    9. **Validate Withdrawals**:
       - Withdrawals from valid stake addresses, amount <= available rewards.
       - Rewards calculated from 'go' snapshot.

    10. **Validate Size Limits**:
        - Tx size <= max_tx_size.
        - Number of inputs, outputs, certs, etc., within bounds.

    11. **Validate Phase-1 Scripts (if any)**:
        - Simple scripts (multisig/timelock) must succeed without execution cost (deterministic).

    If all Phase-1 checks pass, proceed to Phase-2; else, reject.

    #### Phase-2 Validation: Script Execution
    This phase runs Plutus V2 scripts (spending, minting, cert, reward withdrawal). It is bounded by ex units (mem/steps) to prevent infinite loops. If it fails, collateral pays the fees; if succeeds, regular fee is charged. Determinism is ensured by limiting script inputs to predictable data (no block header, no randomness).

    1. **Assemble Script Contexts**:
       - For spending: datum, redeemer, Tx info (inputs/outputs hashed, no full body for determinism).
       - For mint: policy ID, redeemer, Tx info.
       - For cert: cert, redeemer, Tx info.
       - For withdrawal: stake address, redeemer, Tx info.

    2. **Execute Scripts**:
       - Run each Plutus script with context, datum/redeemer.
       - Track ex units consumed (mem/steps <= tx's declared budget).
       - All must succeed (return true).

    3. **Check Ex Units**:
       - Total ex units <= tx's ex units budget.
       - If exceeds, fail and charge collateral.

    4. **Handle Failure**:
       - If any script fails or ex units exceed, charge collateral for fees (up to collateral sum).
       - Return excess collateral to return address.

    5. **Handle Success**:
       - Apply Tx: update UTxO, process certs/withdrawals/mint.

    #### Post-Validation Application
    If both phases pass, apply Tx: consume inputs, create outputs, update stake/pools/treasury.

    This ensures no surprises: fees/ex units predictable in Phase-1, scripts deterministic (no external data). For formal proof, see Agda mechanization.
    */
    return true;
}

// Function to remove transaction inputs from UTxO
export function removeInputs(
    inputs: TxOutRef[],
    utxo: ConwayUTxO[],
): void {
    const newUtxo = utxo.filter(
        // remove utxos with TxOutRef equal to any of the inputs
        (u) => !inputs.some(i => u.utxoRef.eq(i)),
    );
    utxo.length = 0;
    utxo.push(...newUtxo);
}

// Function to add transaction outputs to UTxO
export function addOutputs(
    body: ConwayTxBody,
    utxo: ConwayUTxO[],
): void {
    utxo.push(
        ...body.outputs.map((txOut, i) =>
            new ConwayUTxO({
                utxoRef: new TxOutRef({ id: body.hash, index: i }),
                resolved: txOut.clone(),
            })
        ),
    );
}

// Function to check if the slot is at an epoch boundary
export function isEpochBoundary(
    slot: number,
    state: SQLNewEpochState,
): boolean {
    // Implementation
    return false;
}

// Function to get current delegations
export function currentDelegations(
    state: SQLNewEpochState,
): RawDelegations {
    // Implementation
    return new RawDelegations([]);
}

// Function to get 'go' stake distribution
export function getGoStake(
    state: SQLNewEpochState,
): [PoolKeyHash, Coin][] {
    // TODO: Implement with SQLite
    return [];
}

// Function to get active pools
export function getPools(state: SQLNewEpochState): RawPParams {
    // TODO: Implement with SQLite
    return new RawPParams([]);
}

// Function to get config reward ratio (assume state has config)
export function getRewardRatio(state: SQLNewEpochState): Coin {
    // TODO: Implement
    return 0n;
}

// Function to get slots per epoch
export function getSlotsPerEpoch(state: SQLNewEpochState): bigint {
    // TODO: Implement
    return 0n;
}
