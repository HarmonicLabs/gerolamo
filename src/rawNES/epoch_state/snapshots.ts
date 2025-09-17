import * as assert from "node:assert/strict";

import {
    Coin,
    Credential,
    CredentialType,
    PoolKeyHash,
    PoolParams,
    StakeCredentials,
} from "@harmoniclabs/cardano-ledger-ts";

import { CborArray, CborMap, CborObj } from "@harmoniclabs/cbor";
import { IPoolDistr } from "../pool_distr";

import { decodeCoin } from "./common";
import { ShelleyProtocolParams } from "../../config/ShelleyGenesisTypes";

const calcPoolDistrEnabled = false;

type _Stake = [Credential<CredentialType>, Coin][];
export interface IStake {
    get stake(): _Stake;
    set stake(s: _Stake);
}

export class RawStake implements IStake {
    _stake: _Stake;

    constructor(stake: _Stake) {
        this._stake = stake;
    }
    static fromCborObj(cborObj: CborObj): RawStake {
        assert.default(cborObj instanceof CborMap);
        return new RawStake(
            cborObj.map.map((entry) => [
                Credential.fromCborObj(entry.k),
                decodeCoin(entry.v),
            ]),
        );
    }

    get stake(): _Stake {
        return this._stake;
    }
    set stake(s: _Stake) {
        this._stake = s;
    }
}

type _Delegations = [Credential<CredentialType>, PoolKeyHash][];

export interface IDelegations {
    get delegations(): _Delegations;
    set delegations(d: _Delegations);
}

export class RawDelegations implements IDelegations {
    _delegations: _Delegations;

    constructor(delegations: _Delegations) {
        this._delegations = delegations;
    }

    static fromCborObj(cborObj: CborObj): RawDelegations {
        assert.default(cborObj instanceof CborMap);
        return new RawDelegations(
            cborObj.map.map((entry) => [
                Credential.fromCborObj(entry.k),
                PoolKeyHash.fromCborObj(entry.v),
            ]),
        );
    }

    get delegations(): _Delegations {
        return this._delegations;
    }
    set delegations(d: _Delegations) {
        this._delegations = d;
    }
}

export type _PParams = [PoolKeyHash, PoolParams][];

export interface IPParams {
    get pparams(): _PParams;
    set pparams(pp: _PParams);
}

export class RawPParams implements IPParams {
    _pparams: _PParams;

    constructor(pparams: _PParams) {
        this._pparams = pparams;
    }

    static fromCborObj(cborObj: CborObj): RawPParams {
        assert.default(cborObj instanceof CborMap);
        return new RawPParams(
            cborObj.map.map((entry) => {
                assert.default(entry.v instanceof CborArray);
                return [
                    PoolKeyHash.fromCborObj(entry.k),
                    PoolParams.fromCborObjArray(entry.v.array),
                ];
            }),
        );
    }

    get pparams(): _PParams {
        return this._pparams;
    }

    set pparams(pp: _PParams) {
        this._pparams = pp;
    }
}

export interface ISnapshot {
    get stake(): IStake;
    set stake(s: IStake);

    get delegations(): IDelegations;
    set delegations(d: IDelegations);

    get poolParams(): IPParams;
    set poolParams(pp: IPParams);
}

export class RawSnapshot implements ISnapshot {
    _stake: RawStake;
    _ssDelegations: RawDelegations;
    _ssPoolParams: RawPParams;

    static tableName = "Snapshot";

    constructor(
        stake: RawStake,
        ssDelegations: RawDelegations,
        ssPoolParams: RawPParams,
    ) {
        this._stake = stake;
        this._ssDelegations = ssDelegations;
        this._ssPoolParams = ssPoolParams;
    }

    static fromCborObj(cborObj: CborObj): RawSnapshot {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 3);

        const [stake, ssDelegations, ssPoolParams] = cborObj.array;

        return new RawSnapshot(
            RawStake.fromCborObj(stake),
            RawDelegations.fromCborObj(ssDelegations),
            RawPParams.fromCborObj(ssPoolParams),
        );
    }

    get stake(): RawStake {
        return this._stake;
    }
    set stake(s: RawStake) {
        this._stake = s;
    }

    get delegations(): RawDelegations {
        return this._ssDelegations;
    }
    set delegations(d: RawDelegations) {
        this._ssDelegations = d;
    }

    get poolParams(): RawPParams {
        return this._ssPoolParams;
    }
    set poolParams(pp: RawPParams) {
        this._ssPoolParams = pp;
    }
}

export function calculatePoolDistr(_snapshots: ISnapshot): IPoolDistr {
    assert.default(calcPoolDistrEnabled);
    return undefined as unknown as IPoolDistr;
}

export interface ISnapshots {
    get stakeMark(): ISnapshot;
    set stakeMark(sm: ISnapshot);

    get stakeSet(): ISnapshot;
    set stakeSet(ss: ISnapshot);

    get stakeGo(): ISnapshot;
    set stakeGo(sg: ISnapshot);

    get fee(): Coin;
    set fee(fee: Coin);
}

export class RawSnapshots implements ISnapshots {
    _ssStakeMark: RawSnapshot;
    _ssStakeSet: RawSnapshot;
    _ssStakeGo: RawSnapshot;
    _ssFee: Coin;

    static tableName = "Snapshots";

    constructor(
        ssStakeMark: RawSnapshot,
        ssStakeSet: RawSnapshot,
        ssStakeGo: RawSnapshot,
        ssFee: Coin,
    ) {
        this._ssStakeMark = ssStakeMark;
        this._ssStakeSet = ssStakeSet;
        this._ssStakeGo = ssStakeGo;
        this._ssFee = ssFee;
    }

    static fromCborObj(cborObj: CborObj): RawSnapshots {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 4);

        const [ssStakeMark, ssStakeSet, ssStakeGo, ssFee] = cborObj.array;

        return new RawSnapshots(
            RawSnapshot.fromCborObj(ssStakeMark),
            RawSnapshot.fromCborObj(ssStakeSet),
            RawSnapshot.fromCborObj(ssStakeGo),
            decodeCoin(ssFee),
        );
    }

    get stakeMark(): RawSnapshot {
        return this._ssStakeMark;
    }
    set stakeMark(sm: RawSnapshot) {
        this._ssStakeMark = sm;
    }

    get stakeSet(): RawSnapshot {
        return this._ssStakeSet;
    }
    set stakeSet(ss: RawSnapshot) {
        this._ssStakeSet = ss;
    }

    get stakeGo(): RawSnapshot {
        return this._ssStakeGo;
    }
    set stakeGo(sg: RawSnapshot) {
        this._ssStakeGo = sg;
    }

    get fee(): Coin {
        return this._ssFee;
    }
    set fee(fee: Coin) {
        this._ssFee = fee;
    }
}

export interface IProtocolParams {
    get pparams(): ShelleyProtocolParams;
    set pparams(pp: ShelleyProtocolParams);
}

export class RawProtocolParams implements IProtocolParams {
    _pparams: ShelleyProtocolParams;

    constructor(pparams: ShelleyProtocolParams) {
        this._pparams = pparams;
    }

    static fromCborObj(cborObj: CborObj): RawProtocolParams {
        assert.default(cborObj instanceof CborMap);
        // Parse CBOR map into ShelleyProtocolParams structure
        // For now, return default values - this would need full implementation
        const defaultParams: ShelleyProtocolParams = {
            protocolVersion: { minor: 0, major: 0 },
            decentralisationParam: 0,
            eMax: 0,
            extraEntropy: { tag: "NeutralNonce" },
            maxTxSize: 0,
            maxBlockBodySize: 0,
            maxBlockHeaderSize: 0,
            minFeeA: 0,
            minFeeB: 0,
            minUTxOValue: 0,
            poolDeposit: 500000000,
            minPoolCost: 340000000,
            keyDeposit: 2000000,
            nOpt: 150,
            rho: 0.003,
            tau: 0.2,
            a0: 0.3,
        };
        return new RawProtocolParams(defaultParams);
    }

    get pparams(): ShelleyProtocolParams {
        return this._pparams;
    }

    set pparams(pp: ShelleyProtocolParams) {
        this._pparams = pp;
    }
}
