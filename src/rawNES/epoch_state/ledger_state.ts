import { CborArray, CborMap, CborObj } from "@harmoniclabs/cbor";
import { Coin, TxOut, TxOutRef, UTxO } from "@harmoniclabs/cardano-ledger-ts";

import { decodeCoin } from "./common";

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
        utxosGovState: Eras.GovState | unknown,
        utxosInstantStake: Eras.InstantStake | unknown,
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
        const [
            utxosUTxO,
            utxosDeposited,
            utxosFees,
            _govState,
            _instantStake,
            utxosDonation,
        ] = (cborObj as CborArray).array;

        if (!(utxosUTxO instanceof CborMap)) throw new Error();
        return new RawUTxOState(
            (utxosUTxO as CborMap).map.map(
                (entry) =>
                    new UTxO({
                        utxoRef: TxOutRef.fromCborObj(entry.k),
                        resolved: TxOut.fromCborObj(entry.v),
                    }),
            ),
            decodeCoin(utxosDeposited),
            decodeCoin(utxosFees),
            undefined,
            undefined,
            decodeCoin(utxosDonation),
        );
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
    _lsCertState: Eras.CertState | unknown;

    constructor(
        lsUTxOState: RawUTxOState,
        lsCertState: Eras.CertState | unknown,
    ) {
        this._lsUTxOState = lsUTxOState;
        this._lsCertState = lsCertState;
    }

    static fromCborObj(cborObj: CborObj): RawLedgerState {
        if (!(cborObj instanceof CborArray)) throw new Error();
        if ((cborObj as CborArray).array.length !== 2) throw new Error();
        const [_lsCertState, lsUTxOState] = (cborObj as CborArray).array;

        return new RawLedgerState(
            RawUTxOState.fromCborObj(lsUTxOState),
            undefined,
        );
    }

    get UTxOState(): RawUTxOState {
        return this._lsUTxOState;
    }
    set UTxOState(us: RawUTxOState) {
        this._lsUTxOState = us;
    }

    get certState(): Eras.CertState | unknown {
        return this._lsCertState;
    }
    set certState(cs: Eras.CertState | unknown) {
        this._lsCertState = cs;
    }
}
