import {
    Coin,
    ConwayBlock,
    ConwayTxBody,
    ConwayUTxO,
    defaultProtocolParameters,
    Hash32,
    IUTxO,
    MultiEraBlock,
    ProtocolParameters,
    TxOutRef,
    UTxO,
    Value,
} from "@harmoniclabs/cardano-ledger-ts/";
import {
    PoolKeyHash,
    StakeCredentials,
    VRFKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";

import { INewEpochState } from "../../rawNES";
import {
    IDelegations,
    IPParams,
    ISnapshots,
} from "../../rawNES/epoch_state/snapshots";
import { ChainTip } from "@harmoniclabs/ouroboros-miniprotocols-ts";

export const PRECISION = BigInt(10) ** BigInt(34);
export const EPS = 0n;

export enum ExpOrdering {
    GT,
    LT,
    UNKNOWN,
}

export type ExpCmpOrdering = {
    iterations: bigint;
    estimation: ExpOrdering;
    approx: number;
};

/// The state of the ledger split into two sub-components:
///
/// - A _stable_ and persistent storage, which contains the part of the state which known to be
///   final. Fundamentally, this contains the aggregated state of the ledger that is at least 'k'
///   blocks old; where 'k' is the security parameter of the protocol.
///
/// - A _volatile_ state, which is maintained as a sequence of diff operations to be applied on
///   top of the _stable_ store. It contains at most 'GlobalParameters::consensus_security_param' entries; old entries
///   get persisted in the stable storage when they are popped out of the volatile state.

export class VolatileState {
    _utxos: IUTxO[];
    _pools?: IPParams;
    _accounts?: IDelegations;
    _fees: Value;

    constructor(
        utxos: IUTxO[],
        pools: IPParams | undefined,
        accounts: IDelegations | undefined,
        fees: Value,
    ) {
        this._utxos = utxos;
        this._pools = pools;
        this._accounts = accounts;
        this._fees = fees;
    }

    static fromBlock(block: ConwayBlock): VolatileState {
        return new VolatileState(
            block.transactionBodies.map(convertOutputsToUTxOs).flat(),
            undefined,
            undefined,
            Value.lovelaces(
                block.transactionBodies.map((body) => body.fee).reduce((a, b) =>
                    a + b
                ),
            ),
        );
    }
}

export function convertOutputsToUTxOs(body: ConwayTxBody): UTxO[] {
    const hash = body.hash ?? new Hash32(body.toCborBytes());
    return body.outputs.map((out, i) =>
        new ConwayUTxO({
            utxoRef: new TxOutRef({ id: hash, index: i }),
            resolved: out,
        })
    );
}

export class AnchoredVolatileState {
    _tip: ChainTip;
    _state: VolatileState;

    constructor(tip: ChainTip, state: VolatileState) {
        this._tip = tip;
        this._state = state;
    }

    static fromBlock(
        tip: ChainTip,
        block: MultiEraBlock,
    ): AnchoredVolatileState {
        return new AnchoredVolatileState(
            tip,
            new VolatileState(
                (block.block.transactionBodies as ConwayTxBody[]).map((
                    txBody,
                ) => txBody.inputs).flat(),
                undefined as unknown as IPParams,
                undefined as unknown as IDelegations,
                undefined as unknown as Value,
            ),
        );
    }
}

export class MockChainState {
    stable: INewEpochState;

    /// A handle to the stable store, shared across all ledger instances.
    snapshots: ISnapshots;

    /// Our own in-memory vector of volatile deltas to apply onto the stable store in due time.
    volatile: {
        cache: UTxO[];
        sequence: AnchoredVolatileState[];
    };

    /// The computed rewards summary to be applied on the next epoch boundary. This is computed
    /// once in the epoch, and held until the end where it is reset.
    ///
    /// It also contains the latest stake distribution computed from the previous epoch, which we
    /// hold onto the epoch boundary. In the epoch boundary, the stake distribution becomes
    /// available for the leader schedule verification, whereas the stake distribution previously
    /// used for leader schedule is moved as rewards stake.
    rewards_summary: unknown;

    /// A (shared) collection of the latest stake distributions. Those are used both during rewards
    /// calculations, and for leader schedule verification.
    ///
    /// TODO: StakeDistribution are relatively large objects that typically present a lot of
    /// duplications. We won't usually store more than 3 of them at the same time, since we get rid
    /// of them when no longer needed (after rewards calculations).
    ///
    /// Yet, we could imagine a more compact representation where keys for pool and accounts
    /// wouldn't be so much duplicated between snapshots. Instead, we could use an array of values
    /// for each key. On a distribution of 1M+ stake credentials, that's ~26MB of memory per
    /// duplicate.
    stake_distributions: unknown;

    /// The era history for the network this store is related to.
    era_history: unknown;

    global_parameters: unknown;

    static protocol_parameters: ProtocolParameters = defaultProtocolParameters;
}

export const BYRON_SLOTS_PER_EPOCH = 21600n;
export const SHELLEY_SLOTS_PER_EPOCH = 432000n;
export const BYRON_EPOCHS = 208n;
