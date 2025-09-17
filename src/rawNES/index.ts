import {
    CborArray,
    CborObj,
    CborPositiveRational,
    CborUInt,
    isRawCborObj,
} from "@harmoniclabs/cbor";
import {
    Address,
    Coin,
    Epoch,
    Hash32,
    PoolKeyHash,
    PoolParams,
    PoolRelay,
    poolRelayToCborObj,
    PubKeyHash,
    Rational,
    StakeAddress,
    StakeCredentials,
    TxOutRef,
    VRFKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";
import { uint8ArrayEq } from "@harmoniclabs/uint8array-utils";

import { IBlocksMade, RawBlocksMade } from "./blocks";
import { IEpochState, RawEpochState } from "./epoch_state/";
import { IPulsingRewUpdate, RawPulsingRewUpdate } from "./rewards_update";
import { IPoolDistr, RawPoolDistr } from "./pool_distr";
import {
    IStashedAVVMAddresses,
    RawStashedAVVMAddresses,
} from "./stashed_avvm_addresses";

import * as assert from "node:assert/strict";
import { IReadWriteNES } from "../types";
import { RawChainAccountState } from "./epoch_state/chain_account_state";
import { RawLedgerState, RawUTxOState } from "./epoch_state/ledger_state";
import {
    RawDelegations,
    RawPParams,
    RawProtocolParams,
    RawSnapshot,
    RawSnapshots,
    RawStake,
} from "./epoch_state/snapshots";
import { RawLikelihoods, RawNonMyopic } from "./epoch_state/non_myopic";

export interface INewEpochState {
    get lastEpochModified(): Epoch;
    set lastEpochModified(value: Epoch);

    get prevBlocks(): IBlocksMade;
    set prevBlocks(value: IBlocksMade);

    get currBlocks(): IBlocksMade;
    set currBlocks(value: IBlocksMade);

    get epochState(): IEpochState;
    set epochState(value: IEpochState);

    get pulsingRewUpdate(): IPulsingRewUpdate;
    set pulsingRewUpdate(value: IPulsingRewUpdate);

    get poolDistr(): IPoolDistr;
    set poolDistr(value: IPoolDistr);

    get stashedAvvmAddresses(): IStashedAVVMAddresses;
    set stashedAvvmAddresses(value: IStashedAVVMAddresses);
}

export class RawNewEpochState {
    // implements INewEpochState
    _nesEl: Epoch;
    _nesBprev: RawBlocksMade;
    _nesBcur: RawBlocksMade;
    _nesEs: RawEpochState;
    _nesRu: RawPulsingRewUpdate;
    _nesPd: RawPoolDistr;
    _stashedAVVMAddresses: RawStashedAVVMAddresses;
    _slotsPerKESPeriod: bigint;
    _maxKESEvolutions: bigint;

    static init(
        startEpoch: bigint = 0n,
        slotsPerKESPeriod: bigint = 1n,
        maxKESEvolutions: bigint = 1n,
    ): RawNewEpochState {
        // Default protocol parameters from Shelley genesis
        const defaultPparams = new RawProtocolParams({
            protocolVersion: { minor: 0, major: 2 },
            decentralisationParam: 0,
            eMax: 18,
            extraEntropy: { tag: "NeutralNonce" },
            maxTxSize: 16384,
            maxBlockBodySize: 90112,
            maxBlockHeaderSize: 1100,
            minFeeA: 44,
            minFeeB: 155381,
            minUTxOValue: 1000000,
            poolDeposit: 500000000,
            minPoolCost: 340000000,
            keyDeposit: 2000000,
            nOpt: 150,
            rho: 0.003,
            tau: 0.2,
            a0: 0.3,
        });

        return new RawNewEpochState(
            startEpoch,
            new RawBlocksMade([]),
            new RawBlocksMade([]),
            new RawEpochState(
                new RawChainAccountState(0n, 0n),
                new RawLedgerState(
                    new RawUTxOState([], 0n, 0n, undefined, undefined, 0n),
                    undefined,
                ),
                // undefined as unknown as RawSnapshots,
                new RawSnapshots(
                    new RawSnapshot(
                        new RawStake([]),
                        new RawDelegations([]),
                        new RawPParams([]),
                    ),
                    new RawSnapshot(
                        new RawStake([]),
                        new RawDelegations([]),
                        new RawPParams([]),
                    ),
                    new RawSnapshot(
                        new RawStake([]),
                        new RawDelegations([]),
                        new RawPParams([]),
                    ),
                    0n,
                ),
                new RawNonMyopic(
                    new RawLikelihoods(new Map()),
                    0n,
                ),
                defaultPparams,
            ),
            undefined as unknown as RawPulsingRewUpdate,
            new RawPoolDistr([], 0n),
            new RawStashedAVVMAddresses([]),
            slotsPerKESPeriod,
            maxKESEvolutions,
        );
    }

    constructor(
        nesEl: Epoch,
        nesBprev: RawBlocksMade,
        nesBcur: RawBlocksMade,
        nesEs: RawEpochState,
        nesRu: RawPulsingRewUpdate,
        nesPd: RawPoolDistr,
        stashedAVVMAddresses: RawStashedAVVMAddresses,
        slotsPerKESPeriod: bigint,
        maxKESEvolutions: bigint,
    ) {
        this._nesEl = nesEl;
        this._nesBprev = nesBprev;
        this._nesBcur = nesBcur;
        this._nesEs = nesEs;
        this._nesRu = nesRu;
        this._nesPd = nesPd;
        this._stashedAVVMAddresses = stashedAVVMAddresses;
        this._slotsPerKESPeriod = slotsPerKESPeriod;
        this._maxKESEvolutions = maxKESEvolutions;
    }

    static fromCborObj(cborObj: CborObj) {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 7);
        const [
            lastEpochModified,
            prevBlocks,
            currBlocks,
            epochState,
            rewardsUpdate,
            poolDistr,
            stashedAVVMAddrs,
        ] = cborObj.array;

        // this._nesEl = LastEpochModified.fromCborObj(lastEpochModified);
        assert.default(lastEpochModified instanceof CborUInt);
        return new RawNewEpochState(
            lastEpochModified.num,
            RawBlocksMade.fromCborObj(prevBlocks),
            RawBlocksMade.fromCborObj(currBlocks),
            RawEpochState.fromCborObj(epochState),
            RawPulsingRewUpdate.fromCborObj(rewardsUpdate),
            RawPoolDistr.fromCborObj(poolDistr),
            RawStashedAVVMAddresses.fromCborObj(stashedAVVMAddrs),
            1, // slotsPerKESPeriod
            1, // maxKESEvolutions
        );
    }

    get lastEpochModified(): Epoch {
        return this._nesEl;
    }
    set lastEpochModified(value: Epoch) {
        this._nesEl = value;
    }

    get prevBlocks(): RawBlocksMade {
        return this._nesBprev;
    }
    set prevBlocks(value: RawBlocksMade) {
        this._nesBprev = value;
    }

    get currBlocks(): RawBlocksMade {
        return this._nesBcur;
    }
    set currBlocks(value: RawBlocksMade) {
        this._nesBcur = value;
    }

    get epochState(): RawEpochState {
        return this._nesEs;
    }
    set epochState(value: RawEpochState) {
        this._nesEs = value;
    }

    get pulsingRewUpdate(): RawPulsingRewUpdate {
        return this._nesRu;
    }
    set pulsingRewUpdate(value: RawPulsingRewUpdate) {
        this._nesRu = value;
    }

    get poolDistr(): RawPoolDistr {
        return this._nesPd;
    }
    set poolDistr(value: RawPoolDistr) {
        this._nesPd = value;
    }

    get stashedAvvmAddresses(): RawStashedAVVMAddresses {
        return this._stashedAVVMAddresses;
    }
    set stashedAvvmAddresses(value: RawStashedAVVMAddresses) {
        this._stashedAVVMAddresses = value;
    }

    get slotsPerKESPeriod(): bigint {
        return this._slotsPerKESPeriod;
    }

    set slotsPerKESPeriod(s: bigint) {
        this._slotsPerKESPeriod = s;
    }

    get maxKESEvolutions(): bigint {
        return this._maxKESEvolutions;
    }

    set maxKESEvolutions(e: bigint) {
        this._maxKESEvolutions = e;
    }

    GET_nes_pd_individual_total_pool_stake(pkh: PoolKeyHash): Coin {
        const entry = this.poolDistr.unPoolDistr.find(([p, ips]) =>
            uint8ArrayEq(p.toCborBytes(), pkh.toCborBytes())
        );
        return entry ? entry[1].individualTotalPoolStake : 0n;
    }
}
