import { TxOut, TxOutRef, UTxO } from "@harmoniclabs/cardano-ledger-ts";
import { CborMap, CborObj } from "@harmoniclabs/cbor";

export interface IStashedAVVMAddresses {
    get value(): UTxO[];
    set value(v: UTxO[]);
}
export class RawStashedAVVMAddresses implements IStashedAVVMAddresses {
    _value: UTxO[];
    constructor(v: UTxO[]) {
        this._value = v;
    }

    static fromCborObj(cborObj: CborObj): RawStashedAVVMAddresses {
        return new RawStashedAVVMAddresses(
            cborObj instanceof CborMap
                ? cborObj.map.map(
                    (entry) =>
                        new UTxO({
                            utxoRef: TxOutRef.fromCborObj(entry.k),
                            resolved: TxOut.fromCborObj(entry.v),
                        }),
                )
                : [],
        );
    }

    get value(): UTxO[] {
        return this._value;
    }
    set value(v: UTxO[]) {
        this._value = v;
    }
}
