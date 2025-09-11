import {
    Coin,
    partialShelleyProtocolParamsToJson,
    PoolKeyHash,
    StakeCredentials,
    StakeCredentialsType,
} from "@harmoniclabs/cardano-ledger-ts";
import {
    CborArray,
    CborMap,
    CborObj,
    CborSimple,
    CborTag,
    CborUInt,
} from "@harmoniclabs/cbor";
import { INonMyopic, RawNonMyopic } from "./epoch_state/non_myopic";
import { decodeCoin, ILikelihood, RawLikelihood } from "./epoch_state/common";
import * as assert from "node:assert/strict";
import { CanBeUInteger } from "@harmoniclabs/cardano-ledger-ts/dist/utils/ints";
import { RewardSnapshot } from "./_rewards_update";

const nonCompleteUpdatesEnabled = false;

export enum PulsingRewUpdateKind {
    Pulsing,
    Complete,
}

type _IPulsingRewUpdate<
    K extends PulsingRewUpdateKind = PulsingRewUpdateKind,
> = K extends PulsingRewUpdateKind.Pulsing ? IPulsing
    : K extends PulsingRewUpdateKind.Complete ? IComplete
    : never;

type _RawPulsingRewUpdate<
    K extends PulsingRewUpdateKind = PulsingRewUpdateKind,
> = K extends PulsingRewUpdateKind.Pulsing ? RawPulsing
    : K extends PulsingRewUpdateKind.Complete ? RawComplete
    : never;

export interface IPulsingRewUpdate {
    get value(): _IPulsingRewUpdate;
    set value(pru: _IPulsingRewUpdate);
}

export class RawPulsingRewUpdate implements IPulsingRewUpdate {
    _value: _RawPulsingRewUpdate;

    constructor(v: _RawPulsingRewUpdate) {
        this._value = v;
    }

    static fromCborObj(cborObj: CborObj): RawPulsingRewUpdate {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 1);

        // WHY, CHARLES?????? WHY????????????????????????????????
        const [d] = cborObj.array;
        assert.default(d instanceof CborArray);
        assert.equal(d.array.length, 2);

        const [choice, data] = d.array;
        assert.default(choice instanceof CborUInt);

        return new RawPulsingRewUpdate(
            choice.num
                ? new RawComplete(RawRewardUpdate.fromCborObj(data))
                : RawPulsing.fromCborObj(data),
        );
    }

    get value(): _IPulsingRewUpdate {
        return this._value as _IPulsingRewUpdate;
    }
    set value(pru: _IPulsingRewUpdate) {
        this._value = pru as _RawPulsingRewUpdate;
    }
}

export interface IProtVer {
    get pvMajor(): bigint;
    set pvMajor(v: bigint);

    get pvMinor(): bigint;
    set pvMinor(v: bigint);
}

export class RawProtVer implements IProtVer {
    _pvMajor: bigint;
    _pvMinor: bigint;

    constructor(pvMajor: bigint, pvMinor: bigint) {
        this._pvMajor = pvMajor;
        this._pvMinor = pvMinor;
    }

    static fromCborObj(cborObj: CborObj): RawProtVer {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 2);

        const [pvMajor, pvMinor] = cborObj.array;
        assert.default(pvMajor instanceof CborUInt);
        assert.default(pvMinor instanceof CborUInt);

        return new RawProtVer(
            pvMajor.num,
            pvMinor.num,
        );
    }

    get pvMajor(): bigint {
        return this._pvMajor;
    }
    set pvMajor(v: bigint) {
        this._pvMajor = v;
    }

    get pvMinor(): bigint {
        return this._pvMinor;
    }
    set pvMinor(v: bigint) {
        this._pvMinor = v;
    }
}

export interface IRewardSnapshot {
    get fees(): Coin;
    set fees(f: Coin);

    get protocolVersion(): IProtVer;
    set protocolVersion(pv: IProtVer);

    get nonMyopic(): INonMyopic;
    set nonMyopic(nm: INonMyopic);

    get deltaR1(): Coin;
    set deltaR1(dr1: Coin);

    get R(): Coin;
    set R(r: Coin);

    get deltaT1(): Coin;
    set deltaT1(dt1: Coin);

    get likelihoods(): [PoolKeyHash, ILikelihood][];
    set likelihoods(lh: [PoolKeyHash, ILikelihood][]);

    get leaders(): [StakeCredentials, IReward[]][];
    set leaders(l: [StakeCredentials, IReward[]][]);
}

export class RawRewardSnapshot implements IRewardSnapshot {
    _fees: Coin;
    _protocolVersion: RawProtVer;
    _nonMyopic: RawNonMyopic;
    _deltaR1: Coin;
    _R: Coin;
    _deltaT1: Coin;
    _likelihoods: [PoolKeyHash, RawLikelihood][];
    _leaders: [StakeCredentials, RawReward[]][];

    constructor(
        fees: Coin,
        pv: RawProtVer,
        nm: RawNonMyopic,
        dr1: Coin,
        R: Coin,
        dt1: Coin,
        likelihoods: [PoolKeyHash, RawLikelihood][],
        leaders: [StakeCredentials, RawReward[]][],
    ) {
        this._fees = fees;
        this._protocolVersion = pv;
        this._nonMyopic = nm;
        this._deltaR1 = dr1;
        this._R = R;
        this._deltaT1 = dt1;
        this._likelihoods = likelihoods;
        this._leaders = leaders;
    }

    static fromCborObj(cborObj: CborObj): RawRewardSnapshot {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array, 8);

        const [
            rewFees,
            rewProtocolVersion,
            rewNonMyopic,
            rewDeltaR1,
            rewR,
            rewDeltaT1,
            rewLikelihoods,
            rewLeaders,
        ] = cborObj.array;

        assert.default(rewLikelihoods instanceof CborMap);
        assert.default(rewLeaders instanceof CborMap);

        return new RawRewardSnapshot(
            decodeCoin(rewFees),
            RawProtVer.fromCborObj(rewProtocolVersion),
            RawNonMyopic.fromCborObj(rewNonMyopic),
            decodeCoin(rewDeltaR1),
            decodeCoin(rewR),
            decodeCoin(rewDeltaT1),
            rewLikelihoods.map.map((entry) => [
                PoolKeyHash.fromCborObj(entry.k),
                RawLikelihood.fromCborObj(entry.v),
            ]),
            rewLeaders.map.map((entry) => {
                assert.default(entry.v instanceof CborArray);
                return [
                    StakeCredentials.fromCborObj(entry.k),
                    entry.v.array.map((cObj: CborObj) =>
                        RawReward.fromCborObj(cObj)
                    ),
                ];
            }),
        );
    }

    get fees(): Coin {
        return this._fees;
    }
    set fees(f: Coin) {
        this._fees = f;
    }

    get protocolVersion(): RawProtVer {
        return this._protocolVersion;
    }
    set protocolVersion(pv: RawProtVer) {
        this._protocolVersion = pv;
    }

    get nonMyopic(): RawNonMyopic {
        return this._nonMyopic;
    }
    set nonMyopic(nm: RawNonMyopic) {
        this._nonMyopic = nm;
    }

    get deltaR1(): Coin {
        return this._deltaR1;
    }
    set deltaR1(dr1: Coin) {
        this._deltaR1 = dr1;
    }

    get R(): Coin {
        return this._R;
    }
    set R(r: Coin) {
        this._R = r;
    }

    get deltaT1(): Coin {
        return this._deltaT1;
    }
    set deltaT1(dt1: Coin) {
        this._deltaT1 = dt1;
    }

    get likelihoods(): [PoolKeyHash, RawLikelihood][] {
        return this._likelihoods;
    }
    set likelihoods(lh: [PoolKeyHash, RawLikelihood][]) {
        this._likelihoods = lh;
    }

    get leaders(): [StakeCredentials, RawReward[]][] {
        return this._leaders;
    }
    set leaders(l: [StakeCredentials, RawReward[]][]) {
        this._leaders = l;
    }
}

export interface IPulser {
    get accumRewardAns(): [StakeCredentials, IReward][];
    set accumRewardAns(ara: [StakeCredentials, IReward][]);

    get recentRewardAns(): [StakeCredentials, IReward[]][];
    set recentRewardAns(rra: [StakeCredentials, IReward[]][]);
}
export class RawPulser implements IPulser {
    _accumRewardAns: [StakeCredentials, RawReward][];
    _recentRewardAns: [StakeCredentials, RawReward[]][];

    constructor(
        ara: [StakeCredentials, RawReward][],
        rra: [StakeCredentials, RawReward[]][],
    ) {
        this._accumRewardAns = ara;
        this._recentRewardAns = rra;
    }

    static fromCborObj(cborObj: CborObj): RawPulser {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 2);

        const [accumRewardAns, recentRewardAns] = cborObj.array;

        assert.default(accumRewardAns instanceof CborMap);
        assert.default(recentRewardAns instanceof CborMap);

        return new RawPulser(
            accumRewardAns.map.map((entry) => [
                StakeCredentials.fromCborObj(entry.k),
                RawReward.fromCborObj(entry.v),
            ]),
            recentRewardAns.map.map((entry) => {
                assert.default(entry.v instanceof CborArray);
                return [
                    StakeCredentials.fromCborObj(entry.k),
                    entry.v.array.map((cObj: CborObj) =>
                        RawReward.fromCborObj(cObj)
                    ),
                ];
            }),
        );
    }

    get accumRewardAns(): [StakeCredentials, RawReward][] {
        return this._accumRewardAns;
    }
    set accumRewardAns(ara: [StakeCredentials, RawReward][]) {
        this._accumRewardAns = ara;
    }

    get recentRewardAns(): [StakeCredentials, RawReward[]][] {
        return this._recentRewardAns;
    }
    set recentRewardAns(rra: [StakeCredentials, RawReward[]][]) {
        this._recentRewardAns = rra;
    }
}

export interface IPulsing {
    get value(): [IRewardSnapshot, IPulser];
    set value(v: [IRewardSnapshot, IPulser]);
}

export class RawPulsing {
    _value: [RawRewardSnapshot, RawPulser];

    constructor(v: [RawRewardSnapshot, RawPulser]) {
        this._value = v;
    }

    static fromCborObj(cborObj: CborObj): RawPulsing {
        assert.default(nonCompleteUpdatesEnabled);

        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 2);

        const [rewardSnapshot, pulser] = cborObj.array;
        return new RawPulsing([
            RawRewardSnapshot.fromCborObj(rewardSnapshot),
            RawPulser.fromCborObj(pulser),
        ]);
    }
}

export enum RewardType {
    MemberReward,
    LeaderReward,
}

export interface IReward {
    get type(): RewardType;
    set type(rt: RewardType);

    get pool(): PoolKeyHash;
    set pool(pkh: PoolKeyHash);

    get amount(): Coin;
    set amount(a: Coin);
}

export class RawReward implements IReward {
    _rewardType: RewardType;
    _rewardPool: PoolKeyHash;
    _rewardAmount: Coin;

    constructor(rt: RewardType, rp: PoolKeyHash, ra: Coin) {
        this._rewardType = rt;
        this._rewardPool = rp;
        this._rewardAmount = ra;
    }

    static fromCborObj(cborObj: CborObj): RawReward {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 3);

        const [rewardType, rewardPool, rewardAmount] = cborObj.array;
        assert.default(rewardType instanceof CborUInt);
        assert.default(rewardType.num === 1n || rewardType.num === 0n);

        return new RawReward(
            rewardType.num ? RewardType.LeaderReward : RewardType.MemberReward,
            PoolKeyHash.fromCborObj(rewardPool),
            decodeCoin(rewardAmount),
        );
    }

    get type(): RewardType {
        return this._rewardType;
    }
    set type(rt: RewardType) {
        this._rewardType = rt;
    }

    get pool(): PoolKeyHash {
        return this._rewardPool;
    }
    set pool(pkh: PoolKeyHash) {
        this._rewardPool = pkh;
    }

    get amount(): Coin {
        return this._rewardAmount;
    }
    set amount(a: Coin) {
        this._rewardAmount = a;
    }
}

export interface IRewardUpdate {
    get deltaT(): Coin;
    set deltaT(dt: Coin);

    get deltaR(): Coin;
    set deltaR(dr: Coin);

    get rs(): [StakeCredentials, IReward[]][];
    set rs(rs: [StakeCredentials, IReward[]][]);

    get deltaF(): Coin;
    set deltaF(df: Coin);

    get nonMyopic(): INonMyopic;
    set nonMyopic(nm: INonMyopic);
}
export class RawRewardUpdate implements IRewardUpdate {
    _deltaT: Coin;
    _deltaR: Coin;
    _rs: [StakeCredentials, RawReward[]][];
    _deltaF: Coin;
    _nonMyopic: RawNonMyopic;

    constructor(
        dt: Coin,
        dr: Coin,
        rs: [StakeCredentials, RawReward[]][],
        df: Coin,
        nm: RawNonMyopic,
    ) {
        this._deltaT = dt;
        this._deltaR = dr;
        this._rs = rs;
        this._deltaF = df;
        this._nonMyopic = nm;
    }

    static fromCborObj(cborObj: CborObj): RawRewardUpdate {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 5);

        const [deltaT, deltaR, rs, deltaF, nonMyopic] = cborObj.array;
        assert.default(rs instanceof CborMap);

        return new RawRewardUpdate(
            decodeCoin(deltaT),
            decodeCoin(deltaR),
            rs.map.map((entry) => {
                assert.default(entry.v instanceof CborTag);
                assert.default(entry.v.data instanceof CborArray);
                return [
                    StakeCredentials.fromCborObj(entry.k),
                    entry.v.data.array.map((cObj) =>
                        RawReward.fromCborObj(cObj)
                    ),
                ];
            }),
            decodeCoin(deltaF),
            RawNonMyopic.fromCborObj(nonMyopic),
        );
    }

    get deltaT(): Coin {
        return this._deltaT;
    }
    set deltaT(dt: Coin) {
        this._deltaT = dt;
    }

    get deltaR(): Coin {
        return this._deltaR;
    }
    set deltaR(dr: Coin) {
        this._deltaR = dr;
    }

    get rs(): [StakeCredentials, RawReward[]][] {
        return this._rs;
    }
    set rs(rs: [StakeCredentials, RawReward[]][]) {
        this._rs = rs;
    }

    get deltaF(): Coin {
        return this._deltaF;
    }
    set deltaF(df: Coin) {
        this._deltaF = df;
    }

    get nonMyopic(): RawNonMyopic {
        return this._nonMyopic;
    }
    set nonMyopic(nm: RawNonMyopic) {
        this._nonMyopic = nm;
    }
}

export interface IComplete {
    get value(): IRewardUpdate;
    set value(v: IRewardUpdate);
}
export class RawComplete implements IComplete {
    _value: RawRewardUpdate;

    constructor(v: RawRewardUpdate) {
        this._value = v;
    }

    get value(): RawRewardUpdate {
        return this._value;
    }
    set value(v: RawRewardUpdate) {
        this._value = v;
    }
}
