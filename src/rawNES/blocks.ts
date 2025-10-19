import { CborMap, CborObj, CborUInt } from "@harmoniclabs/cbor";
import { PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";

import * as assert from "node:assert/strict";

type _BlocksMade = [PoolKeyHash, bigint][];
export interface IBlocksMade {
    get value(): _BlocksMade;
    set value(v: _BlocksMade);
}

export class RawBlocksMade implements IBlocksMade {
    _value: _BlocksMade;

    constructor(value: _BlocksMade) {
        this._value = value;
    }

    static fromCborObj(cborObj: CborObj): RawBlocksMade {
        assert.default(cborObj instanceof CborMap);

        return new RawBlocksMade(cborObj.map.map((entry) => {
            assert.default(entry.v instanceof CborUInt);
            return [PoolKeyHash.fromCborObj(entry.k), entry.v.num];
        }));
    }

    get value(): _BlocksMade {
        return [];
    }
    set value(v: _BlocksMade) {
        this._value = v;
    }
}
