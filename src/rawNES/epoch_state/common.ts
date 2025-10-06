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
        if (!(cborObj instanceof CborArray)) throw new Error();

        return new RawLikelihood(
            (cborObj as CborArray).array.map((v) => {
                if (!(v instanceof CborSimple)) throw new Error();
                if ((v as CborSimple).numAs !== "float") throw new Error();
                if (!(typeof (v as CborSimple).simple === "number")) {
                    throw new Error();
                }

                return (v as CborSimple).simple as number;
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
    if (!(cborObj instanceof CborUInt)) throw new Error();
    return (cborObj as CborUInt).num;
}
