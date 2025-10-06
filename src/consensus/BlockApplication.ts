// src/consensus/BlockApplicator.ts

import {
    Certificate,
    CertificateType,
    CertPoolRegistration,
    CertPoolRetirement,
    CertRegistrationDeposit,
    CertStakeDelegation,
    CertStakeDeRegistration,
    CertStakeRegistration,
    CertStakeRegistrationDeleg,
    CertStakeVoteRegistrationDeleg,
    CertUnRegistrationDeposit,
    Coin,
    ConwayBlock,
    ConwayTx,
    ConwayTxBody,
    ConwayUTxO,
    Credential,
    Hash32,
    isCertificate,
    isITxWitnessSet,
    MultiEraBlock,
    PoolKeyHash,
    TxOutRef,
} from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";

import { RawNewEpochState } from "../rawNES";
import { VolatileState } from "./validation/types";
import { AnchoredVolatileState, Point } from "./AnchoredVolatileState";

import {
    RawDelegations,
    RawPParams,
    RawStake,
} from "../rawNES/epoch_state/snapshots";
import { calculateCardanoEpoch } from "./validation";
import { toHex, uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { containsKeys } from "@harmoniclabs/obj-utils";
import { isEmptyStatement } from "typescript";

const EPOCH_TRANSITION_ENABLED = false;

// Function to apply a block to the state and return an AnchoredVolatileState
export function applyBlock(
    block: MultiEraBlock,
    state: RawNewEpochState,
    issuer: PoolKeyHash,
): AnchoredVolatileState {
    // Implementation

    // Apply block - extract Conway block from MultiEraBlock
    // For now, assume all blocks are Conway-era (era 7) as per test expectations
    if (block.era !== 7) {
        throw new Error(
            `Unsupported era: ${block.era}. Currently only Conway-era (era 7) blocks are supported.`,
        );
    }

    const conwayBlock = block.block as ConwayBlock;

    if (EPOCH_TRANSITION_ENABLED) {
        const start_slot = conwayBlock.header.body.slot;
        const tip_slot = BigInt(state.lastEpochModified);

        const current_epoch = calculateCardanoEpoch(start_slot);
        const tip_epoch = calculateCardanoEpoch(tip_slot);

        if (current_epoch > tip_epoch) {
            // Epoch Change
            throw new Error();
        }
    }

    if (
        conwayBlock.transactionBodies.length !==
            conwayBlock.transactionWitnessSets.length
    ) throw new Error();

    conwayBlock.transactionBodies.map((tb, i: number) => {
        if (!isITxWitnessSet(conwayBlock.transactionWitnessSets[i])) {
            throw new Error();
        }
        return new ConwayTx({
            body: tb,
            witnesses: conwayBlock.transactionWitnessSets[i],
        });
    }).forEach((tx) => applyTx(tx, state));

    // Create VolatileState from the applied block
    const volatileState = VolatileState.fromBlock(conwayBlock);

    // Create anchor point from block header
    // Compute block hash from header bytes using Blake2b
    const headerBytes = conwayBlock.header.toCborBytes();
    const blockHeaderHash = new Hash32(blake2b_256(headerBytes));
    const point: Point = {
        slot: conwayBlock.header.body.slot,
        hash: blockHeaderHash,
    };

    // Return AnchoredVolatileState
    return AnchoredVolatileState.anchor(volatileState, point, issuer);
}

// Function to apply a transaction to the state
export function applyTx(tx: ConwayTx, state: RawNewEpochState): void {
    // Implementation
    if (!validateTx(tx, state)) throw new Error();

    const refs = tx.body.inputs.map((input) => input.utxoRef);
    if (!validateInputsExist(refs, state)) {
        throw new Error("Transaction inputs do not exist in UTxO set");
    }

    removeInputs(refs, state);
    addOutputs(tx.body, state);

    tx.body.certs?.forEach((cert) => processCert(cert, state));
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

    if (!containsKeys(cert, "certType")) {
        throw new Error();
    }

    switch (cert.certType) {
        case CertificateType.StakeRegistration: // Deprecated; handle for backward compatibility
            // Add cert.stakeCredential to stake set
            // @ts-ignore
            const stakeCredReg =
                (cert as CertStakeRegistration).stakeCredential;
            if (
                state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => uint8ArrayEq(sc.toCborBytes(), stakeCredReg.toCborBytes()))
            ) {
                throw new Error(
                    `Stake credential ${
                        toHex(stakeCredReg.toCborBytes())
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
            const stakeCredToRemove =
                (cert as CertStakeDeRegistration).stakeCredential;
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => uint8ArrayEq(
                    sc.toCborBytes(),
                    stakeCredToRemove.toCborBytes(),
                ) // Buffer.from(sc.toCbor().toBuffer()).toString("hex") ===
                    // Buffer.from(stakeCredToRemove.toCbor().toBuffer()).toString(
                    //     "hex",
                    // )
                )
            ) {
                throw new Error(
                    `Stake credential ${
                        toHex(stakeCredToRemove.toCborBytes())
                    } is not registered`,
                );
            }
            removeStakeCredential(
                state.epochState.snapshots.stakeSet.stake,
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
                state.epochState.snapshots.stakeMark.delegations,
                cert as CertStakeDelegation,
            );
            break;

        case CertificateType.PoolRegistration: // Required for consensus
            // Add cert.poolParams to pool params
            const poolParams = (cert as CertPoolRegistration).poolParams;
            state.epochState.snapshots.stakeMark.poolParams.pparams.push([
                poolParams.operator,
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
                    uint8ArrayEq(
                        pkh.toCborBytes(),
                        poolKeyHashRet.toCborBytes(),
                    )
                );
            if (poolIndex >= 0) {
                (state.epochState.snapshots.stakeMark.poolParams
                    .pparams[poolIndex][1] as any).retirementEpoch =
                        (cert as CertPoolRetirement).epoch;
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
            const stakeCredRegDep =
                (cert as CertRegistrationDeposit).stakeCredential;
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => uint8ArrayEq(
                    sc.toCborBytes(),
                    stakeCredRegDep.toCborBytes(),
                ))
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    stakeCredRegDep,
                    0n,
                ]);
            }
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as CertRegistrationDeposit).deposit);
            break;

        case CertificateType.UnRegistrationDeposit: // Required for consensus
            // Remove cert.stakeCredential from stake set
            const stakeCredUnRegDep =
                (cert as CertUnRegistrationDeposit).stakeCredential;
            removeStakeCredential(
                state.epochState.snapshots.stakeSet.stake,
                stakeCredUnRegDep,
            );
            // Refund cert.deposit to treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) +
                BigInt((cert as CertUnRegistrationDeposit).deposit);
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
                ) => uint8ArrayEq(
                    sc.toCborBytes(),
                    (cert as CertStakeRegistrationDeleg).stakeCredential
                        .toCborBytes(),
                ))
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    (cert as CertStakeRegistrationDeleg).stakeCredential,
                    0n,
                ]);
            }
            // Update delegation snapshot
            updateDelegationInSnapshot(
                state.epochState.snapshots.stakeMark.delegations,
                cert as CertStakeRegistrationDeleg,
            );
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as CertStakeRegistrationDeleg).coin);
            break;

        case CertificateType.VoteRegistrationDeleg: // Governance; medium priority
            // TODO: Update governance state
            break;

        case CertificateType.StakeVoteRegistrationDeleg: // Required for consensus
            // Add cert.stakeCredential to stake set
            if (
                !state.epochState.snapshots.stakeSet.stake.stake.some((
                    [sc, _],
                ) => uint8ArrayEq(
                    sc.toCborBytes(),
                    (cert as CertStakeVoteRegistrationDeleg).stakeCredential
                        .toCborBytes(),
                ))
            ) {
                state.epochState.snapshots.stakeSet.stake.stake.push([
                    (cert as CertStakeVoteRegistrationDeleg).stakeCredential,
                    0n,
                ]);
            }
            // Update delegation and governance state
            updateDelegationInSnapshot(
                state.epochState.snapshots.stakeMark.delegations,
                cert as CertStakeVoteRegistrationDeleg,
            );
            // TODO: Update governance for DRep
            // Deduct cert.deposit from treasury
            state.epochState.chainAccountState.casTreasury =
                BigInt(state.epochState.chainAccountState.casTreasury) -
                BigInt((cert as CertStakeVoteRegistrationDeleg).coin);
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
            throw new Error(
                `Unknown certificate type: ${(cert as Certificate).certType}`,
            );
    }
}

// Helper function to remove stake credential from stake list
function removeStakeCredential(
    stakeList: RawStake,
    cred: Credential,
): void {
    const index = stakeList.stake.findIndex(([sc, _]) =>
        // (sc as any).toCbor().toBuffer().toString("hex") ===
        //     (cred as any).toCbor().toBuffer().toString("hex")
        uint8ArrayEq(sc.toCborBytes(), cred.toCborBytes())
    );
    if (index >= 0) {
        stakeList.stake.splice(index, 1);
    }
}

// Helper function to update delegation in snapshot
function updateDelegationInSnapshot(
    delegations: RawDelegations,
    cert:
        | CertStakeDelegation
        | CertStakeRegistrationDeleg
        | CertStakeVoteRegistrationDeleg,
): void {
    const index = delegations.delegations.findIndex(([sc, _]) =>
        uint8ArrayEq(sc.toCborBytes(), cert.stakeCredential.toCborBytes())
    );
    if (index >= 0) {
        delegations.delegations[index][1] = cert.poolKeyHash;
    } else {
        delegations.delegations.push([cert.stakeCredential, cert.poolKeyHash]);
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
    // For chain following, perform basic structural checks
    // Trust network consensus for full Phase-1/Phase-2 validation

    // 1. Basic structure validation
    if (!tx.body.inputs || tx.body.inputs.length === 0 ||
        !tx.body.outputs || tx.body.outputs.length === 0) {
        return false;
    }

    if (tx.body.fee === undefined || tx.body.fee < 0n) {
        return false;
    }

    // 2. Ensure inputs are distinct
    const inputRefs = tx.body.inputs.map(input => input.utxoRef.toCborBytes());
    if (new Set(inputRefs.map(ref => toHex(ref))).size !== inputRefs.length) {
        return false;
    }

    // 3. Basic certificate validation
    if (tx.body.certs && !tx.body.certs.every(isCertificate)) {
        return false;
    }

    // Additional basic checks for chain following
    // 4. Validate UTxO inputs exist
    if (!validateInputsExist(tx.body.inputs.map(input => input.utxoRef), state)) {
        return false;
    }

    // 5. Basic balance check (simplified)
    let inputSum = 0n;
    for (const input of tx.body.inputs) {
        const utxo = state.epochState.ledgerState.UTxOState.UTxO.find(
            u => u.utxoRef.eq(input.utxoRef)
        );
        if (!utxo) return false;
        inputSum += utxo.resolved.value.lovelaces;
    }

    let outputSum = tx.body.outputs.reduce((sum, output) => sum + output.value.lovelaces, 0n);
    if (inputSum < outputSum + tx.body.fee) {
        return false;
    }

    // Trust network for scripts, collateral, certificates, etc.
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
    return true;
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
    return state.epochState.snapshots.stakeGo.stake.stake.map((v) =>
        [
            state.epochState.snapshots.stakeGo.delegations.delegations.find(
                (u) => uint8ArrayEq(u[0].toCborBytes(), v[0].toCborBytes()),
            )![1],
            v[1],
        ] as [PoolKeyHash, Coin]
    );
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
