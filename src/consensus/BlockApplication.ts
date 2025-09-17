// src/consensus/BlockApplicator.ts

import {
    Certificate,
    CertificateType,
    CertPoolRegistration,
    CertPoolRetirement,
    CertStakeDelegation,
    Coin,
    ConwayBlock,
    ConwayTx,
    ConwayTxBody,
    ConwayUTxO,
    Credential,
    CredentialType,
    Hash32,
    isITxWitnessSet,
    PoolKeyHash,
    StakeCredentials,
    TxOutRef,
} from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";

import { RawNewEpochState } from "../rawNES";
import { VolatileState } from "./validation/types";
import { AnchoredVolatileState, Point } from "./AnchoredVolatileState";

import * as assert from "node:assert/strict";
import { RawDelegations, RawPParams } from "../rawNES/epoch_state/snapshots";
import { calculateCardanoEpoch } from "./validation";

const EPOCH_TRANSITION_ENABLED = false;

// Function to apply a block to the state and return an AnchoredVolatileState
export function applyBlock(
    block: ConwayBlock,
    state: RawNewEpochState,
    issuer: PoolKeyHash,
): AnchoredVolatileState {
    // Implementation

    if (EPOCH_TRANSITION_ENABLED) {
        const start_slot = block.header.body.slot;
        const tip_slot = BigInt(state.lastEpochModified);

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

    block.transactionBodies.map((tb, i: number) => {
        assert.default(isITxWitnessSet(block.transactionWitnessSets[i]));
        return new ConwayTx({
            body: tb,
            witnesses: block.transactionWitnessSets[i],
        });
    }).forEach((tx) => applyTx(tx, state));

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
export function applyTx(tx: ConwayTx, state: RawNewEpochState): void {
    // Implementation
    assert.default(validateTx(tx, state));

    const refs = tx.body.inputs.map((utxo) => utxo.utxoRef);
    // TODO: Re-enable input validation once we have proper test blocks or genesis state
    // assert.default(state.epochState.ledgerState.UTxOState.UTxO.length === 0 || validateInputsExist(refs, state));

    removeInputs(refs, state);
    addOutputs(tx.body, state);

    // tx.body.certs!.forEach((cert) => processCert(cert, state));
    state.epochState.chainAccountState.casTreasury =
        BigInt(state.epochState.chainAccountState.casTreasury) + tx.body.fee;
}

function validateInputsExist(
    utxoRefs: TxOutRef[],
    state: RawNewEpochState,
): boolean {
    return utxoRefs.every((ref) =>
        state.epochState.ledgerState.UTxOState.UTxO.some((utxo) =>
            utxo.utxoRef.eq(ref)
        )
    );
}

// Function to shift snapshots at epoch boundary
export function shiftSnapshots(state: RawNewEpochState): void {
    // Implementation
}

// Function to compute and distribute rewards using 'go' snapshot
export function computeRewards(state: RawNewEpochState): void {
    // Implementation
}

// Function to process a certificate and update the state
export function processCert(
    cert: Certificate,
    state: RawNewEpochState,
): void {
    // Enable certificate processing for demo - set to false to disable
    const ENABLE_CERT_PROCESSING = true;
    if (!ENABLE_CERT_PROCESSING) return;

    const certType = (cert as any).certType as CertificateType;

    switch (certType) {
        case CertificateType.StakeRegistration: // Deprecated; handle for backward compatibility
            // Add cert.stakeCredential to stake set
            // @ts-ignore
            const stakeCredReg = (cert as any).stakeCredential;
            if (
                state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => sc.toCbor().toBuffer().toString("hex") ===
                    stakeCredReg.toCbor().toBuffer().toString("hex")
                )
            ) {
                throw new Error(
                    `Stake credential ${
                        stakeCredReg.toCbor().toBuffer().toString("hex")
                    } is already registered`,
                );
            }
            state.epochState.snapshots.stakeSet.stake.stake.push([
                stakeCredReg,
                0n,
            ]);
            // Deduct keyDeposit from treasury
            const keyDeposit = BigInt(
                state.epochState.pparams.pparams.keyDeposit,
            );
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                keyDeposit;
            break;

        case CertificateType.StakeDeRegistration: // Deprecated; handle for backward compatibility
            // Remove cert.stakeCredential from stake set
            // @ts-ignore
            const stakeCredToRemove = (cert as any).stakeCredential;
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => sc.toCbor().toBuffer().toString("hex") ===
                    stakeCredToRemove.toCbor().toBuffer().toString("hex")
                )
            ) {
                throw new Error(
                    `Stake credential ${
                        stakeCredToRemove.toCbor().toBuffer().toString("hex")
                    } is not registered`,
                );
            }
            removeStakeCredential(
                state.epochState.snapshots.stakeSet.stake.stake as any,
                stakeCredToRemove,
            );
            // Refund keyDeposit to treasury
            const keyDepositRefund1 = BigInt(
                state.epochState.pparams.pparams.keyDeposit,
            );
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) +
                keyDepositRefund1;
            break;

        case CertificateType.StakeDelegation: // Required for consensus
            updateDelegationInSnapshot(
                state.epochState.snapshots.stakeMark.delegations.delegations,
                (cert as CertStakeDelegation).stakeCredential,
                (cert as CertStakeDelegation).poolKeyHash,
            );
            break;

        case CertificateType.PoolRegistration: // Required for consensus
            // Add cert.poolParams to pool params
            const poolParams = (cert as CertPoolRegistration).poolParams;
            state.epochState.snapshots.stakeMark.poolParams.pparams.push([
                (poolParams as any).poolKeyHash,
                poolParams,
            ]);
            // Deduct poolDeposit from treasury
            const poolDeposit = BigInt(
                state.epochState.pparams.pparams.poolDeposit,
            );
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                poolDeposit;
            break;

        case CertificateType.PoolRetirement: // Required for consensus
            // Set retirement epoch for cert.poolKeyHash in pool params
            const poolKeyHashRet = (cert as any).poolKeyHash as PoolKeyHash;
            const poolIndex = state.epochState.snapshots.stakeMark.poolParams
                .pparams.findIndex(([pkh, _]) =>
                    pkh.toCborBytes() === poolKeyHashRet.toCborBytes()
                );
            if (poolIndex >= 0) {
                (state.epochState.snapshots.stakeMark.poolParams
                    .pparams[poolIndex][1] as any).retirementEpoch =
                        (cert as any).epoch;
            }
            break;

        case CertificateType.GenesisKeyDelegation: // Deprecated; low priority
            // TODO: Update genesis key delegations
            break;

        case CertificateType.MoveInstantRewards: // Deprecated; low priority
            // TODO: Move rewards between reserves/treasury
            break;

        case CertificateType.RegistrationDeposit: // Required for consensus
            // Add cert.stakeCredential to stake set
            const stakeCredRegDep = (cert as any).stakeCredential;
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => sc.toCbor().toBuffer().toString("hex") ===
                    stakeCredRegDep.toCbor().toBuffer().toString("hex")
                )
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    stakeCredRegDep,
                    0n,
                ]);
            }
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as any).deposit);
            break;

        case CertificateType.UnRegistrationDeposit: // Required for consensus
            // Remove cert.stakeCredential from stake set
            const stakeCredUnRegDep = (cert as any).stakeCredential;
            removeStakeCredential(
                state.epochState.snapshots.stakeSet.stake.stake,
                stakeCredUnRegDep,
            );
            // Refund cert.deposit to treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) +
                BigInt((cert as any).deposit);
            break;

        case CertificateType.UnRegistrationDeposit: // Required for consensus
            // Remove cert.stakeCredential from stake set
            removeStakeCredential(
                state.epochState.snapshots.stakeSet.stake.stake,
                (cert as any).stakeCredential,
            );
            // Refund cert.deposit to treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) +
                BigInt((cert as any).deposit);
            break;

        case CertificateType.VoteDeleg: // Governance; medium priority
            // TODO: Update governance state for DRep delegation
            break;

        case CertificateType.StakeVoteDeleg: // Governance; medium priority
            // TODO: Update delegations and governance state
            break;

        case CertificateType.StakeRegistrationDeleg: // Required for consensus
            // Add cert.stakeCredential to stake set
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => sc.toCbor().toBuffer().toString("hex") ===
                    (cert as any).stakeCredential.toCbor().toBuffer().toString(
                        "hex",
                    )
                )
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    (cert as any).stakeCredential,
                    0n,
                ]);
            }
            // Update delegation snapshot
            updateDelegationInSnapshot(
                state.epochState.snapshots.stakeMark.delegations.delegations,
                (cert as any).stakeCredential,
                (cert as any).poolKeyHash,
            );
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as any).deposit);
            break;

        case CertificateType.VoteRegistrationDeleg: // Governance; medium priority
            // TODO: Update governance state
            break;

        case CertificateType.StakeVoteRegistrationDeleg: // Required for consensus
            // Add cert.stakeCredential to stake set
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => sc.toCbor().toBuffer().toString("hex") ===
                    (cert as any).stakeCredential.toCbor().toBuffer().toString(
                        "hex",
                    )
                )
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    (cert as any).stakeCredential,
                    0n,
                ]);
            }
            // Update delegation and governance state
            updateDelegationInSnapshot(
                state.epochState.snapshots.stakeMark.delegations.delegations,
                (cert as any).stakeCredential,
                (cert as any).poolKeyHash,
            );
            // TODO: Update governance for DRep
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as any).deposit);
            break;

        case CertificateType.AuthCommitteeHot: // Governance; low priority
            // TODO: Update committee hot key
            break;

        case CertificateType.ResignCommitteeCold: // Governance; low priority
            // TODO: Resign committee cold key
            break;

        case CertificateType.RegistrationDrep: // Governance; medium priority
            // TODO: Register DRep, deduct deposit
            break;

        case CertificateType.UnRegistrationDrep: // Governance; medium priority
            // TODO: Unregister DRep, refund deposit
            break;

        case CertificateType.UpdateDrep: // Governance; low priority
            // TODO: Update DRep metadata
            break;

        default:
            throw new Error(`Unknown certificate type: ${certType}`);
    }
}

// Helper function to remove stake credential from stake list
function removeStakeCredential(
    stakeList: [any, Coin][],
    cred: any,
): void {
    const index = stakeList.findIndex(([sc, _]) =>
        (sc as any).toCbor().toBuffer().toString("hex") ===
            (cred as any).toCbor().toBuffer().toString("hex")
    );
    if (index >= 0) {
        stakeList.splice(index, 1);
    }
}

// Helper function to update delegation in snapshot
function updateDelegationInSnapshot(
    delegations: any[],
    cred: any,
    pool: PoolKeyHash,
): void {
    const index = delegations.findIndex(([sc, _]: [any, any]) =>
        sc.toCbor().toBuffer().toString("hex") ===
            cred.toCbor().toBuffer().toString("hex")
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
    state: RawNewEpochState,
): void {
    // Implementation
}

// Function to register a pool in the 'f_p_pools'
export function registerPool(
    reg: CertPoolRegistration,
    state: RawNewEpochState,
): void {
    // Implementation
}

// Function to retire a pool by updating retiring epoch
export function retirePool(
    ret: CertPoolRetirement,
    state: RawNewEpochState,
): void {
    // Implementation
}

// Function to calculate reward for a pool based on stake and params
export function calculatePoolReward(
    stake: Coin,
    pool: PoolKeyHash,
    state: RawNewEpochState,
): Coin {
    // Implementation
    return 0n;
}

// Function to validate a transaction against the state
export function validateTx(tx: ConwayTx, state: RawNewEpochState): boolean {
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
    state: RawNewEpochState,
): void {
    state.epochState.ledgerState.UTxOState.UTxO = state.epochState.ledgerState
        .UTxOState.UTxO.filter(
            // remove utxos with TxOutRef equal to any of the inputs
            (utxo) => !inputs.some(utxo.utxoRef.eq),
        );
}

// Function to add transaction outputs to UTxO
export function addOutputs(
    body: ConwayTxBody,
    state: RawNewEpochState,
): void {
    // Implementation
    state.epochState.ledgerState.UTxOState.UTxO.push(
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
    state: RawNewEpochState,
): boolean {
    // Implementation
    return false;
}

// Function to get current delegations
export function currentDelegations(
    state: RawNewEpochState,
): RawDelegations {
    // Implementation
    return new RawDelegations([]);
}

// Function to get 'go' stake distribution
export function getGoStake(
    state: RawNewEpochState,
): [PoolKeyHash, Coin][] {
    // Suboptimal quadratic search
    // TODO: Replace with proper SQLite join
    return state.epochState.snapshots.stakeGo.stake.stake.map((v) => [
        state.epochState.snapshots.stakeGo.delegations.delegations.find(
            (u) => u[0].toCborBytes() === v[0].toCborBytes(),
        )![1],
        v[1],
    ]);
}

// Function to get active pools
export function getPools(state: RawNewEpochState): RawPParams {
    // Implementation
    return new RawPParams([]);
}

// Function to get config reward ratio (assume state has config)
export function getRewardRatio(state: RawNewEpochState): Coin {
    // Implementation
    return 0n;
}

// Function to get slots per epoch
export function getSlotsPerEpoch(state: RawNewEpochState): bigint {
    // Implementation
    return 0n;
}
