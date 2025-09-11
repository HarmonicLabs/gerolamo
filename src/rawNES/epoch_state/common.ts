import * as assert from "node:assert/strict";

import { CborArray, CborObj, CborSimple, CborUInt } from "@harmoniclabs/cbor";
import { Coin } from "@harmoniclabs/cardano-ledger-ts";

export interface ILikelihood {
    get value(): number[];
    set value(v: number[]);
}

export class RawLikelihood implements ILikelihood {
    _value: number[];
    static tableName = "Likelihood";

    constructor(value: number[]) {
        this._value = value;
    }

    static fromCborObj(cborObj: CborObj): RawLikelihood {
        assert.default(cborObj instanceof CborArray);

        return new RawLikelihood(
            cborObj.array.map((v) => {
                assert.default(v instanceof CborSimple);
                assert.equal(v.numAs, "float");
                assert.default(typeof v.simple === "number");

                return v.simple;
            }),
        );
    }

    get value(): number[] {
        return this._value;
    }

    set value(v: number[]) {
        this._value = v;
    }
}

export function decodeCoin(cborObj: CborObj): Coin {
    assert.default(cborObj instanceof CborUInt);
    return cborObj.num;
}
