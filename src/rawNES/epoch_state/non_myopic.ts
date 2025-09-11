import { CborArray, CborMap, CborObj } from "@harmoniclabs/cbor";
import { Coin, PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";
import { decodeCoin, ILikelihood, RawLikelihood } from "./common";

import * as assert from "node:assert/strict";

type _Likelihoods = Map<PoolKeyHash, ILikelihood>;
export interface ILikelihoods {
    // get likelihoods(): _Likelihoods;
    get likelihoods(): _Likelihoods;
    set likelihoods(v: _Likelihoods);
}

export class RawLikelihoods implements ILikelihoods {
    _likelihoods: _Likelihoods;

    constructor(likelihoods: _Likelihoods) {
        this._likelihoods = likelihoods;
    }

    get likelihoods(): _Likelihoods {
        return this._likelihoods;
    }
    set likelihoods(v: _Likelihoods) {
        this._likelihoods = v;
    }
}

export interface INonMyopic {
    get likelihoods(): ILikelihoods;
    set likelihoods(v: ILikelihoods);

    get rewardPot(): Coin;
    set rewardPot(v: Coin);
}

export class RawNonMyopic implements INonMyopic {
    _likelihoodsNM: RawLikelihoods;
    _rewardPotNM: Coin;

    constructor(
        likelihoodsNM: RawLikelihoods,
        rewardPotNM: Coin,
    ) {
        this._likelihoodsNM = likelihoodsNM;
        this._rewardPotNM = rewardPotNM;
    }

    static fromCborObj(cborObj: CborObj): RawNonMyopic {
        assert.default(cborObj instanceof CborArray);
        assert.equal(cborObj.array.length, 2);

        const [likelihoodsNM, rewardPotNM] = cborObj.array;
        assert.default(likelihoodsNM instanceof CborMap);

        return new RawNonMyopic(
            new RawLikelihoods(
                new Map(
                    likelihoodsNM.map.map((entry) => {
                        return [
                            PoolKeyHash.fromCborObj(entry.k),
                            RawLikelihood.fromCborObj(entry.v),
                        ];
                    }),
                ),
            ),
            decodeCoin(rewardPotNM),
        );
    }

    get likelihoods() {
        return this._likelihoodsNM;
    }
    set likelihoods(v) {
        this._likelihoodsNM = v;
    }

    get rewardPot() {
        return this._rewardPotNM;
    }
    set rewardPot(v) {
        this._rewardPotNM = v;
    }
}
