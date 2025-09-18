import { Coin, Epoch } from "@harmoniclabs/cardano-ledger-ts";
import { decodeCoin } from "./common";
import { CborArray, CborObj } from "@harmoniclabs/cbor";

export interface IChainAccountState {
    get casTreasury(): Coin;
    set casTreasury(t: Coin);

    get casReserves(): Coin;
    set casReserves(r: Coin);
}

export class RawChainAccountState implements IChainAccountState {
    _casTreasury: Coin;
    _casReserves: Coin;

    constructor(casTreasury: Coin, casReserves: Coin) {
        this._casTreasury = casTreasury;
        this._casReserves = casReserves;
    }

    static fromCborObj(cborObj: CborObj): RawChainAccountState {
        if (!(cborObj instanceof CborArray)) throw new Error();
        if ((cborObj as CborArray).array.length !== 2) throw new Error();

        const [casTreasury, casReserves] = (cborObj as CborArray).array;
        return new RawChainAccountState(
            decodeCoin(casTreasury),
            decodeCoin(casReserves),
        );
    }

    get casTreasury(): Coin {
        return this._casTreasury;
    }
    set casTreasury(t: Coin) {
        this._casTreasury = t;
    }

    get casReserves(): Coin {
        return this._casReserves;
    }
    set(r: Coin) {
        this._casReserves = r;
    }
}
