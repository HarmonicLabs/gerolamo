import { CborArray, CborMap, CborObj, CborUInt } from "@harmoniclabs/cbor";
import { Coin, TxOut, TxOutRef, UTxO } from "@harmoniclabs/cardano-ledger-ts";

import { decodeCoin, encodeCoin } from "./common";

import * as Eras from "../era_dependent";

export interface IUTxOState {
    get UTxO(): UTxO[];
    set UTxO(v: UTxO);

    get deposited(): Coin;
    set deposited(d: Coin);

    get fees(): Coin;
    set fees(f: Coin);

    get govState(): Eras.GovState | unknown;
    set govState(gs: Eras.GovState | unknown);

    get instantStake(): Eras.InstantStake | unknown;
    set instantStake(is: Eras.InstantStake | unknown);

    get donation(): Coin;
    set donation(v: Coin);
}

export class RawUTxOState implements IUTxOState {
    _UTxO: UTxO[];
    _deposited: Coin;
    _fees: Coin;
    _govState: Eras.GovState | unknown;
    _instantStake: Eras.InstantStake | unknown;
    _donation: Coin;

    constructor(
        utxosUTxO: UTxO[],
        utxosDeposited: Coin,
        utxosFees: Coin,
        utxosGovState: Eras.GovState | CborObj,
        utxosInstantStake: Eras.InstantStake | CborObj,
        utxosDonation: Coin,
    ) {
        this._UTxO = utxosUTxO;
        this._deposited = utxosDeposited;
        this._fees = utxosFees;
        this._govState = utxosGovState;
        this._instantStake = utxosInstantStake;
        this._donation = utxosDonation;
    }

    static fromCborObj(cborObj: CborObj): RawUTxOState {
        if (!(cborObj instanceof CborArray)) throw new Error();
        const array = (cborObj as CborArray).array;
        const len = array.length;
        const utxosUTxO = array[0];
        const utxosDeposited = (len > 1 && array[1] instanceof CborUInt)
            ? array[1]
            : new CborUInt(0n);
        const utxosFees = (len > 2 && array[2] instanceof CborUInt)
            ? array[2]
            : new CborUInt(0n);
        const govState = len > 3 ? array[3] : undefined;
        const instantStake = len > 4 ? array[4] : undefined;
        const utxosDonation = (len > 5 && array[5] instanceof CborUInt)
            ? array[5]
            : new CborUInt(0n);

        console.log("utxosUTxO:", utxosUTxO);
        let utxos: UTxO[];
        if (utxosUTxO instanceof CborMap) {
            utxos = (utxosUTxO as CborMap).map.map(
                (entry) =>
                    new UTxO({
                        utxoRef: TxOutRef.fromCborObj(entry.k),
                        resolved: TxOut.fromCborObj(entry.v),
                    }),
            );
        } else if (utxosUTxO instanceof CborArray) {
            const arr = (utxosUTxO as CborArray).array;
            utxos = [];
            for (let i = 0; i < arr.length; i += 2) {
                if (i + 1 < arr.length) {
                    const k = arr[i];
                    const v = arr[i + 1];
                    if (
                        k instanceof CborArray && v instanceof CborArray &&
                        k.array.length >= 2
                    ) {
                        const txid = k.array[0];
                        const index = k.array[1];
                        try {
                            const utxo = new UTxO({
                                utxoRef: TxOutRef.fromCborObj(
                                    new CborArray([txid, index]),
                                ),
                                resolved: TxOut.fromCborObj(v),
                            });
                            utxos.push(utxo);
                        } catch (e) {
                            console.log("Failed to parse UTxO at i", i, e);
                        }
                    }
                }
            }
        } else {
            throw new Error("utxosUTxO is not CborMap or CborArray");
        }
        return new RawUTxOState(
            utxos,
            decodeCoin(utxosDeposited),
            decodeCoin(utxosFees),
            govState,
            instantStake,
            decodeCoin(utxosDonation),
        );
    }

    static toCborObj(utxoState: RawUTxOState): CborObj {
        return new CborArray([
            new CborMap(utxoState.UTxO.map((utxo) => {
                return {
                    k: utxo.utxoRef.toCborObj(),
                    v: utxo.resolved.toCborObj(),
                };
            })),
            encodeCoin(utxoState.deposited),
            encodeCoin(utxoState.fees),
            utxoState.govState as CborObj,
            utxoState.instantStake as CborObj,
            encodeCoin(utxoState.donation),
        ]);
    }

    get UTxO(): UTxO[] {
        return this._UTxO;
    }
    set UTxO(v: UTxO[]) {
        this._UTxO = v;
    }

    get deposited(): Coin {
        return this._deposited;
    }
    set deposited(d: Coin) {
        this._deposited = d;
    }

    get fees(): Coin {
        return this._fees;
    }
    set fees(f: Coin) {
        this._fees = f;
    }

    get govState(): Eras.GovState | unknown {
        return this._govState;
    }
    set govState(gs: Eras.GovState | unknown) {
        this._govState = gs;
    }

    get instantStake(): Eras.InstantStake | unknown {
        return this._instantStake;
    }
    set instantStake(is: Eras.InstantStake | unknown) {
        this._instantStake = is;
    }

    get donation(): Coin {
        return this._donation;
    }
    set donation(d: Coin) {
        this._donation = d;
    }
}

export interface ILedgerState {
    get UTxOState(): IUTxOState;
    set UTxOState(us: IUTxOState);

    get certState(): Eras.CertState | unknown;
    set certState(cs: Eras.CertState | unknown);
}

export class RawLedgerState implements ILedgerState {
    _lsUTxOState: RawUTxOState;
    _lsCertState: Eras.CertState | CborObj;

    constructor(
        lsUTxOState: RawUTxOState,
        lsCertState: Eras.CertState | CborObj,
    ) {
        this._lsUTxOState = lsUTxOState;
        this._lsCertState = lsCertState;
    }

    static fromCborObj(cborObj: CborObj): RawLedgerState {
        if (!(cborObj instanceof CborArray)) throw new Error();
        if ((cborObj as CborArray).array.length < 2) throw new Error();
        const [lsUTxOState, _lsCertState] = (cborObj as CborArray).array;

        return new RawLedgerState(
            RawUTxOState.fromCborObj(lsUTxOState),
            _lsCertState,
        );
    }

    static toCborObj(ls: RawLedgerState): CborObj {
        return new CborArray([
            ls.certState as CborObj,
            RawUTxOState.toCborObj(ls.UTxOState),
        ]);
    }

    get UTxOState(): RawUTxOState {
        return this._lsUTxOState;
    }
    set UTxOState(us: RawUTxOState) {
        this._lsUTxOState = us;
    }

    get certState(): Eras.CertState | CborObj {
        return this._lsCertState;
    }
    set certState(cs: Eras.CertState | CborObj) {
        this._lsCertState = cs;
    }
}
