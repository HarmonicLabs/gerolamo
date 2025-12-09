import { CborArray, CborObj } from "@harmoniclabs/cbor";

import { ILedgerState, RawLedgerState } from "./ledger_state";
import {
    IChainAccountState,
    RawChainAccountState,
} from "./chain_account_state";
import {
    IProtocolParams,
    ISnapshots,
    RawProtocolParams,
    RawSnapshots,
} from "./snapshots";
import { INonMyopic, RawNonMyopic } from "./non_myopic";
import { defaultShelleyProtocolParameters } from "@harmoniclabs/cardano-ledger-ts";

export interface IEpochState {
    get chainAccountState(): IChainAccountState;
    set chainAccountState(cas: IChainAccountState);

    get ledgerState(): ILedgerState;
    set ledgerState(ls: ILedgerState);

    get snapshots(): ISnapshots;
    set snapshots(s: ISnapshots);

    get nonMyopic(): INonMyopic;
    set nonMyopic(nm: INonMyopic);

    get pparams(): IProtocolParams;
    set pparams(pp: IProtocolParams);
}

export class RawEpochState implements IEpochState {
    _esChainAccountState: RawChainAccountState;
    _esLState: RawLedgerState;
    _esSnapshots: RawSnapshots;
    _esNonMyopic: RawNonMyopic;
    _esPparams: RawProtocolParams;

    static tableName = "EpochState";

    constructor(
        esChainAccountState: RawChainAccountState,
        esLState: RawLedgerState,
        esSnapshots: RawSnapshots,
        esNonMyopic: RawNonMyopic,
        esPparams: RawProtocolParams,
    ) {
        this._esChainAccountState = esChainAccountState;
        this._esLState = esLState;
        this._esSnapshots = esSnapshots;
        this._esNonMyopic = esNonMyopic;
        this._esPparams = esPparams;
    }

    static fromCborObj(cborObj: CborObj): RawEpochState {
        if (!(cborObj instanceof CborArray)) throw new Error();

        const [esChainAccountState, esLState, esSnapshots, esNonMyopic] =
            (cborObj as CborArray).array;

        return new RawEpochState(
            RawChainAccountState.fromCborObj(esChainAccountState),
            RawLedgerState.fromCborObj(esLState),
            RawSnapshots.fromCborObj(esSnapshots),
            RawNonMyopic.fromCborObj(esNonMyopic),
            new RawProtocolParams(defaultShelleyProtocolParameters),
        );
    }

    get chainAccountState(): RawChainAccountState {
        return this._esChainAccountState;
    }
    set chainAccountState(cas: RawChainAccountState) {
        this._esChainAccountState = cas;
    }

    get ledgerState(): RawLedgerState {
        return this._esLState;
    }
    set ledgerState(ls: RawLedgerState) {
        this._esLState = ls;
    }

    get snapshots(): RawSnapshots {
        return this._esSnapshots;
    }
    set snapshots(s: RawSnapshots) {
        this._esSnapshots = s;
    }

    get nonMyopic(): RawNonMyopic {
        return this._esNonMyopic;
    }
    set nonMyopic(nm: RawNonMyopic) {
        this._esNonMyopic = nm;
    }

    get pparams(): RawProtocolParams {
        return this._esPparams;
    }
    set pparams(pp: RawProtocolParams) {
        this._esPparams = pp;
    }
}
