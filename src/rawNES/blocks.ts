import { CborMap, CborObj, CborUInt } from "@harmoniclabs/cbor";
import { PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";

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
        if (!(cborObj instanceof CborMap)) throw new Error();

        return new RawBlocksMade((cborObj as CborMap).map.map((entry) => {
            if (!(entry.v instanceof CborUInt)) throw new Error();
            return [
                PoolKeyHash.fromCborObj(entry.k),
                (entry.v as CborUInt).num,
            ];
        }));
    }

    get value(): _BlocksMade {
        return [];
    }
    set value(v: _BlocksMade) {
        this._value = v;
    }
}
