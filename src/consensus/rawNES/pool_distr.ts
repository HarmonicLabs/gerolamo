import { Coin, PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";
import {
    CborArray,
    CborMap,
    CborObj,
    CborPositiveRational,
} from "@harmoniclabs/cbor";
import { Rational, VRFKeyHash } from "@harmoniclabs/cardano-ledger-ts";

import { decodeCoin } from "./epoch_state/common";

export interface IIndividualPoolStake {
    get individualPoolStake(): Rational;
    set individualPoolStake(ips: Rational);

    get individualTotalPoolStake(): Coin;
    set individualTotalPoolStake(itps: Coin);

    get individualPoolStakeVrf(): VRFKeyHash;
    set individualPoolStakeVrf(ipsv: VRFKeyHash);
}

export class RawIndividualPoolStake implements IIndividualPoolStake {
    _individualPoolStake: Rational;
    _individualTotalPoolStake: Coin;
    _individualPoolStakeVrf: VRFKeyHash;

    constructor(
        ips: Rational,
        itps: Coin,
        ipsv: VRFKeyHash,
    ) {
        this._individualPoolStake = ips;
        this._individualTotalPoolStake = itps;
        this._individualPoolStakeVrf = ipsv;
    }

    static fromCborObj(v: CborObj): RawIndividualPoolStake {
        if (!(v instanceof CborArray)) throw new Error();
        if ((v as CborArray).array.length !== 3) throw new Error();

        const [iPS, individualTotalPoolStake, individualPoolStakeVrf] =
            (v as CborArray).array;
        const individualPoolStake = CborPositiveRational
            .fromCborObjOrUndef(
                iPS,
            );
        if (individualPoolStake === undefined) throw new Error();

        return new RawIndividualPoolStake(
            individualPoolStake,
            decodeCoin(
                individualTotalPoolStake,
            ),
            VRFKeyHash.fromCborObj(
                individualPoolStakeVrf,
            ),
        );
    }

    get individualPoolStake(): Rational {
        return this._individualPoolStake;
    }

    set individualPoolStake(v: Rational) {
        this._individualPoolStake = v;
    }

    get individualTotalPoolStake(): Coin {
        return this._individualTotalPoolStake;
    }
    set individualTotalPoolStake(itps: Coin) {
        this._individualTotalPoolStake = itps;
    }

    get individualPoolStakeVrf(): VRFKeyHash {
        return this._individualPoolStakeVrf;
    }
    set individualPoolStakeVrf(ipsv: VRFKeyHash) {
        this._individualPoolStakeVrf = ipsv;
    }
}

type _PoolDistr = [PoolKeyHash, IIndividualPoolStake][];

export interface IPoolDistr {
    get unPoolDistr(): _PoolDistr;
    set unPoolDistr(pd: _PoolDistr);

    get totalActiveStake(): Coin;
    set totalActiveStake(tas: Coin);
}

export class RawPoolDistr implements IPoolDistr {
    _unPoolDistr: _PoolDistr;
    _pdTotalActiveStake: Coin;

    constructor(unPoolDistr: _PoolDistr, pdActiveTotalStake: Coin) {
        this._unPoolDistr = unPoolDistr;
        this._pdTotalActiveStake = pdActiveTotalStake;
    }

    static fromCborObj(cborObj: CborObj): RawPoolDistr {
        if (!(cborObj instanceof CborArray)) throw new Error();
        if ((cborObj as CborArray).array.length !== 2) throw new Error();

        const [unPoolDistr, pdTotalActiveStake] = (cborObj as CborArray).array;
        if (!(unPoolDistr instanceof CborMap)) throw new Error();

        return new RawPoolDistr(
            (unPoolDistr as CborMap).map.map((entry) => {
                return [
                    PoolKeyHash.fromCborObj(entry.k),
                    RawIndividualPoolStake.fromCborObj(entry.v),
                ];
            }),
            decodeCoin(pdTotalActiveStake),
        );
    }

    get unPoolDistr(): _PoolDistr {
        return this._unPoolDistr;
    }
    set unPoolDistr(pd: _PoolDistr) {
        this._unPoolDistr = pd;
    }

    get totalActiveStake(): Coin {
        return this._pdTotalActiveStake;
    }
    set totalActiveStake(tas: Coin) {
        this._pdTotalActiveStake = tas;
    }
}
