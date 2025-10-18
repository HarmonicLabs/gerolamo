import { Cbor, CborObj, CborArray, CborMap, CborMapEntry, CborUInt, CborPositiveRational } from "@harmoniclabs/cbor";
import { Coin, PoolKeyHash, StakeCredentials, UTxO, TxOutRef, TxOut, Hash32, VRFKeyHash, PoolParams, Rational, Script } from "@harmoniclabs/cardano-ledger-ts";
import {
    createNES,
    loadNES,
    saveBlocksMade,
    loadBlocksMade,
    saveChainAccount,
    loadChainAccount,
    saveUTxO,
    saveUTxOState,
    loadUTxO,
    saveStake,
    loadStake,
    saveDelegations,
    loadDelegations,
    savePoolParams,
    loadPoolParams,
    savePoolDistr,
    loadPoolDistr,
    saveRewards,
    loadRewards,
    saveNonMyopic,
    loadNonMyopic,
    saveStashedAVVM,
    loadStashedAVVM,
    saveSnapshotsMeta,
    loadSnapshotsMeta
} from "./sql";

// Re-implemented types from scratch (no dependency on rawNES)

// Basic types
export type Epoch = bigint;

// Blocks Made
export interface IBlocksMade {
    get value(): [PoolKeyHash, bigint][];
    set value(v: [PoolKeyHash, bigint][]);
}

export class BlocksMade implements IBlocksMade {
    private _value: [PoolKeyHash, bigint][];

    constructor(value: [PoolKeyHash, bigint][]) {
        this._value = value;
    }

    get value(): [PoolKeyHash, bigint][] {
        return this._value;
    }

    set value(v: [PoolKeyHash, bigint][]) {
        this._value = v;
    }

    toCborObj(): CborObj {
        const entries: CborMapEntry[] = [];
        for (const [poolHash, count] of this._value) {
            entries.push({k: poolHash.toCbor() as unknown as CborObj, v: new CborUInt(count)});
        }
        return new CborMap(entries);
    }

    static fromCborObj(cborObj: CborObj): BlocksMade {
        if (!(cborObj instanceof CborMap)) throw new Error("Invalid CBOR for BlocksMade");
        const value: [PoolKeyHash, bigint][] = [];
        for (const {k, v} of cborObj.map) {
            if (!(v instanceof CborUInt)) throw new Error("Invalid count in BlocksMade");
            value.push([new PoolKeyHash((k as any).bytes), v.num]);
        }
        return new BlocksMade(value);
    }
}

// Chain Account State
export interface IChainAccountState {
    get treasury(): Coin;
    set treasury(t: Coin);
    get reserves(): Coin;
    set reserves(r: Coin);
}

export class ChainAccountState implements IChainAccountState {
    private _treasury: Coin;
    private _reserves: Coin;

    constructor(treasury: Coin, reserves: Coin) {
        this._treasury = treasury;
        this._reserves = reserves;
    }

    get treasury(): Coin { return this._treasury; }
    set treasury(t: Coin) { this._treasury = t; }

    get reserves(): Coin { return this._reserves; }
    set reserves(r: Coin) { this._reserves = r; }

    toCborObj(): CborObj {
        return new CborArray([new CborUInt(this._treasury), new CborUInt(this._reserves)]);
    }

    static fromCborObj(cborObj: CborObj): ChainAccountState {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 2) throw new Error("Invalid CBOR for ChainAccountState");
        const [treasury, reserves] = cborObj.array;
        if (!(treasury instanceof CborUInt) || !(reserves instanceof CborUInt)) throw new Error("Invalid values in ChainAccountState");
        return new ChainAccountState(treasury.num, reserves.num);
    }
}

// UTxO State
export interface IUTxOState {
    get utxo(): UTxO[];
    set utxo(v: UTxO[]);
    get deposited(): Coin;
    set deposited(d: Coin);
    get fees(): Coin;
    set fees(f: Coin);
    get donation(): Coin;
    set donation(v: Coin);
}

export class UTxOState implements IUTxOState {
    private _utxo: UTxO[];
    private _deposited: Coin;
    private _fees: Coin;
    private _donation: Coin;

    constructor(utxo: UTxO[], deposited: Coin, fees: Coin, donation: Coin) {
        this._utxo = utxo;
        this._deposited = deposited;
        this._fees = fees;
        this._donation = donation;
    }

    get utxo(): UTxO[] { return this._utxo; }
    set utxo(v: UTxO[]) { this._utxo = v; }

    get deposited(): Coin { return this._deposited; }
    set deposited(d: Coin) { this._deposited = d; }

    get fees(): Coin { return this._fees; }
    set fees(f: Coin) { this._fees = f; }

    get donation(): Coin { return this._donation; }
    set donation(v: Coin) { this._donation = v; }

    toCborObj(): CborObj {
        const utxoEntries: CborMapEntry[] = [];
        for (const utxo of this._utxo) {
            utxoEntries.push({k: utxo.utxoRef.toCbor() as unknown as CborObj, v: utxo.resolved.toCbor() as unknown as CborObj});
        }
        return new CborArray([
            new CborMap(utxoEntries),
            new CborUInt(this._deposited),
            new CborUInt(this._fees),
            new CborUInt(0), // govState placeholder
            new CborUInt(0), // instantStake placeholder
            new CborUInt(this._donation)
        ]);
    }

    static fromCborObj(cborObj: CborObj): UTxOState {
        if (!(cborObj instanceof CborArray) || cborObj.array.length < 6) throw new Error("Invalid CBOR for UTxOState");
        const [utxoMap, deposited, fees, , , donation] = cborObj.array;

        const utxo: UTxO[] = [];
        if (utxoMap instanceof CborMap) {
            for (const {k, v} of utxoMap.map) {
                utxo.push(new UTxO({
                    utxoRef: TxOutRef.fromCborObj(k),
                    resolved: TxOut.fromCborObj(v)
                }));
            }
        }

        if (!(deposited instanceof CborUInt) || !(fees instanceof CborUInt) || !(donation instanceof CborUInt)) {
            throw new Error("Invalid values in UTxOState");
        }

        return new UTxOState(utxo, deposited.num, fees.num, donation.num);
    }
}

// Ledger State
export interface ILedgerState {
    get utxoState(): IUTxOState;
    set utxoState(us: IUTxOState);
}

export class LedgerState implements ILedgerState {
    private _utxoState: UTxOState;

    constructor(utxoState: UTxOState) {
        this._utxoState = utxoState;
    }

    get utxoState(): UTxOState { return this._utxoState; }
    set utxoState(us: UTxOState) { this._utxoState = us; }

    toCborObj(): CborObj {
        return new CborArray([this._utxoState.toCborObj()]);
    }

    static fromCborObj(cborObj: CborObj): LedgerState {
        if (!(cborObj instanceof CborArray) || cborObj.array.length < 1) throw new Error("Invalid CBOR for LedgerState");
        return new LedgerState(UTxOState.fromCborObj(cborObj.array[0]));
    }
}

// Stake
export interface IStake {
    get stake(): Map<StakeCredentials, Coin>;
    set stake(s: Map<StakeCredentials, Coin>);
}

export class Stake implements IStake {
    private _stake: Map<StakeCredentials, Coin>;

    constructor(stake: [StakeCredentials, Coin][]) {
        this._stake = new Map(stake);
    }

    get stake(): Map<StakeCredentials, Coin> {
        return this._stake;
    }

    set stake(s: Map<StakeCredentials, Coin>) {
        this._stake = s;
    }

    toCborObj(): CborObj {
        const entries: CborMapEntry[] = [];
        for (const [creds, amount] of this._stake) {
            entries.push({k: creds.toCbor() as unknown as CborObj, v: new CborUInt(amount)});
        }
        return new CborMap(entries);
    }

    static fromCborObj(cborObj: CborObj): Stake {
        if (!(cborObj instanceof CborMap)) throw new Error("Invalid CBOR for Stake");
        const stake: [StakeCredentials, Coin][] = [];
        for (const {k, v} of cborObj.map) {
            if (!(v instanceof CborUInt)) throw new Error("Invalid amount in Stake");
            stake.push([StakeCredentials.fromCborObj(k), v.num]);
        }
        return new Stake(stake);
    }
}

// Delegations
export interface IDelegations {
    get delegations(): Map<StakeCredentials, PoolKeyHash>;
    set delegations(d: Map<StakeCredentials, PoolKeyHash>);
}

export class Delegations implements IDelegations {
    private _delegations: Map<StakeCredentials, PoolKeyHash>;

    constructor(delegations: [StakeCredentials, PoolKeyHash][]) {
        this._delegations = new Map(delegations);
    }

    get delegations(): Map<StakeCredentials, PoolKeyHash> {
        return this._delegations;
    }

    set delegations(d: Map<StakeCredentials, PoolKeyHash>) {
        this._delegations = d;
    }

    toCborObj(): CborObj {
        const entries: CborMapEntry[] = [];
        for (const [creds, poolHash] of this._delegations) {
            entries.push({k: creds.toCbor() as unknown as CborObj, v: poolHash.toCbor() as unknown as CborObj});
        }
        return new CborMap(entries);
    }

    static fromCborObj(cborObj: CborObj): Delegations {
        if (!(cborObj instanceof CborMap)) throw new Error("Invalid CBOR for Delegations");
        const delegations: [StakeCredentials, PoolKeyHash][] = [];
        for (const {k, v} of cborObj.map) {
            delegations.push([StakeCredentials.fromCborObj(k), PoolKeyHash.fromCborObj(v)]);
        }
        return new Delegations(delegations);
    }
}

// Pool Parameters
export interface IPParams {
    get pparams(): Map<PoolKeyHash, PoolParams>;
    set pparams(p: Map<PoolKeyHash, PoolParams>);
}

export class PParams implements IPParams {
    private _pparams: Map<PoolKeyHash, PoolParams>;

    constructor(pparams: [PoolKeyHash, PoolParams][]) {
        this._pparams = new Map(pparams);
    }

    get pparams(): Map<PoolKeyHash, PoolParams> {
        return this._pparams;
    }

    set pparams(p: Map<PoolKeyHash, PoolParams>) {
        this._pparams = p;
    }

    toCborObj(): CborObj {
        // Simplified - would need full PoolParams serialization
        return new CborMap([]);
    }

    static fromCborObj(cborObj: CborObj): PParams {
        // Simplified - would need full PoolParams deserialization
        return new PParams([]);
    }
}

// Snapshot
export interface ISnapshot {
    get stake(): IStake;
    set stake(s: IStake);
    get delegations(): IDelegations;
    set delegations(d: IDelegations);
    get poolParams(): IPParams;
    set poolParams(p: IPParams);
}

export class Snapshot implements ISnapshot {
    private _stake: Stake;
    private _delegations: Delegations;
    private _poolParams: PParams;

    constructor(stake: Stake, delegations: Delegations, poolParams: PParams) {
        this._stake = stake;
        this._delegations = delegations;
        this._poolParams = poolParams;
    }

    get stake(): Stake { return this._stake; }
    set stake(s: Stake) { this._stake = s; }

    get delegations(): Delegations { return this._delegations; }
    set delegations(d: Delegations) { this._delegations = d; }

    get poolParams(): PParams { return this._poolParams; }
    set poolParams(p: PParams) { this._poolParams = p; }

    toCborObj(): CborObj {
        return new CborArray([
            this._stake.toCborObj(),
            this._delegations.toCborObj(),
            this._poolParams.toCborObj()
        ]);
    }

    static fromCborObj(cborObj: CborObj): Snapshot {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 3) throw new Error("Invalid CBOR for Snapshot");
        return new Snapshot(
            Stake.fromCborObj(cborObj.array[0]),
            Delegations.fromCborObj(cborObj.array[1]),
            PParams.fromCborObj(cborObj.array[2])
        );
    }
}

// Snapshots
export interface ISnapshots {
    get mark(): ISnapshot;
    set mark(sm: ISnapshot);
    get set(): ISnapshot;
    set set(ss: ISnapshot);
    get go(): ISnapshot;
    set go(sg: ISnapshot);
    get fee(): Coin;
    set fee(fee: Coin);
}

export class Snapshots implements ISnapshots {
    private _mark: Snapshot;
    private _set: Snapshot;
    private _go: Snapshot;
    private _fee: Coin;

    constructor(mark: Snapshot, set: Snapshot, go: Snapshot, fee: Coin) {
        this._mark = mark;
        this._set = set;
        this._go = go;
        this._fee = fee;
    }

    get mark(): Snapshot { return this._mark; }
    set mark(sm: Snapshot) { this._mark = sm; }

    get set(): Snapshot { return this._set; }
    set set(ss: Snapshot) { this._set = ss; }

    get go(): Snapshot { return this._go; }
    set go(sg: Snapshot) { this._go = sg; }

    get fee(): Coin { return this._fee; }
    set fee(fee: Coin) { this._fee = fee; }

    toCborObj(): CborObj {
        return new CborArray([
            this._mark.toCborObj(),
            this._set.toCborObj(),
            this._go.toCborObj(),
            new CborUInt(this._fee)
        ]);
    }

    static fromCborObj(cborObj: CborObj): Snapshots {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 4) throw new Error("Invalid CBOR for Snapshots");
        const [mark, set, go, fee] = cborObj.array;
        if (!(fee instanceof CborUInt)) throw new Error("Invalid fee in Snapshots");
        return new Snapshots(
            Snapshot.fromCborObj(mark),
            Snapshot.fromCborObj(set),
            Snapshot.fromCborObj(go),
            fee.num
        );
    }
}

// Non-Myopic
export interface INonMyopic {
    get rewardPot(): Coin;
    set rewardPot(rp: Coin);
}

export class NonMyopic implements INonMyopic {
    private _rewardPot: Coin;

    constructor(rewardPot: Coin) {
        this._rewardPot = rewardPot;
    }

    get rewardPot(): Coin { return this._rewardPot; }
    set rewardPot(rp: Coin) { this._rewardPot = rp; }

    toCborObj(): CborObj {
        return new CborArray([new CborMap([]), new CborUInt(this._rewardPot)]);
    }

    static fromCborObj(cborObj: CborObj): NonMyopic {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 2) throw new Error("Invalid CBOR for NonMyopic");
        const [, rewardPot] = cborObj.array;
        if (!(rewardPot instanceof CborUInt)) throw new Error("Invalid rewardPot in NonMyopic");
        return new NonMyopic(rewardPot.num);
    }
}

// Epoch State
export interface IEpochState {
    get chainAccountState(): IChainAccountState;
    set chainAccountState(cas: IChainAccountState);
    get ledgerState(): ILedgerState;
    set ledgerState(ls: ILedgerState);
    get snapshots(): ISnapshots;
    set snapshots(s: ISnapshots);
    get nonMyopic(): INonMyopic;
    set nonMyopic(nm: INonMyopic);
}

export class EpochState implements IEpochState {
    private _chainAccountState: ChainAccountState;
    private _ledgerState: LedgerState;
    private _snapshots: Snapshots;
    private _nonMyopic: NonMyopic;

    constructor(
        chainAccountState: ChainAccountState,
        ledgerState: LedgerState,
        snapshots: Snapshots,
        nonMyopic: NonMyopic
    ) {
        this._chainAccountState = chainAccountState;
        this._ledgerState = ledgerState;
        this._snapshots = snapshots;
        this._nonMyopic = nonMyopic;
    }

    get chainAccountState(): ChainAccountState { return this._chainAccountState; }
    set chainAccountState(cas: ChainAccountState) { this._chainAccountState = cas; }

    get ledgerState(): LedgerState { return this._ledgerState; }
    set ledgerState(ls: LedgerState) { this._ledgerState = ls; }

    get snapshots(): Snapshots { return this._snapshots; }
    set snapshots(s: Snapshots) { this._snapshots = s; }

    get nonMyopic(): NonMyopic { return this._nonMyopic; }
    set nonMyopic(nm: NonMyopic) { this._nonMyopic = nm; }

    toCborObj(): CborObj {
        return new CborArray([
            this._chainAccountState.toCborObj(),
            this._ledgerState.toCborObj(),
            this._snapshots.toCborObj(),
            this._nonMyopic.toCborObj()
        ]);
    }

    static fromCborObj(cborObj: CborObj): EpochState {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 4) throw new Error("Invalid CBOR for EpochState");
        return new EpochState(
            ChainAccountState.fromCborObj(cborObj.array[0]),
            LedgerState.fromCborObj(cborObj.array[1]),
            Snapshots.fromCborObj(cborObj.array[2]),
            NonMyopic.fromCborObj(cborObj.array[3])
        );
    }
}

// Pulsing Reward Update (simplified)
export interface IPulsingRewUpdate {
    // Placeholder - would need full implementation
}

export class PulsingRewUpdate implements IPulsingRewUpdate {
    toCborObj(): CborObj {
        return new CborArray([new CborUInt(0), new CborArray([])]);
    }

    static fromCborObj(cborObj: CborObj): PulsingRewUpdate {
        return new PulsingRewUpdate();
    }
}

// Pool Distribution
export interface IPoolDistr {
    get unPools(): Map<PoolKeyHash, { stake: Coin; sigma: Rational }>;
    set unPools(up: Map<PoolKeyHash, { stake: Coin; sigma: Rational }>);
    get totalStake(): Coin;
    set totalStake(ts: Coin);
}

export class PoolDistr implements IPoolDistr {
    private _unPools: Map<PoolKeyHash, { stake: Coin; sigma: Rational }>;
    private _totalStake: Coin;

    constructor(unPools: [PoolKeyHash, { stake: Coin; sigma: Rational }][], totalStake: Coin) {
        this._unPools = new Map(unPools);
        this._totalStake = totalStake;
    }

    get unPools(): Map<PoolKeyHash, { stake: Coin; sigma: Rational }> {
        return this._unPools;
    }

    set unPools(up: Map<PoolKeyHash, { stake: Coin; sigma: Rational }>) {
        this._unPools = up;
    }

    get totalStake(): Coin { return this._totalStake; }
    set totalStake(ts: Coin) { this._totalStake = ts; }

    toCborObj(): CborObj {
        const poolEntries: CborMapEntry[] = [];
        for (const [poolHash, distr] of this._unPools) {
            poolEntries.push({k: poolHash.toCbor() as unknown as CborObj, v: new CborArray([
                typeof distr.sigma === 'number' ? new CborUInt(distr.sigma) : new CborPositiveRational((distr.sigma as any).numerator, (distr.sigma as any).denominator),
                new CborUInt(distr.stake)
            ])});
        }
        return new CborArray([new CborMap(poolEntries), new CborUInt(this._totalStake)]);
    }

    static fromCborObj(cborObj: CborObj): PoolDistr {
        if (!(cborObj instanceof CborArray) || cborObj.array.length !== 2) throw new Error("Invalid CBOR for PoolDistr");
        const [poolMap, totalStake] = cborObj.array;
        if (!(totalStake instanceof CborUInt)) throw new Error("Invalid totalStake in PoolDistr");

        const unPools: [PoolKeyHash, { stake: Coin; sigma: Rational }][] = [];
        if (poolMap instanceof CborMap) {
            for (const {k, v} of poolMap.map) {
                if (!(v instanceof CborArray) || v.array.length !== 2) continue;
                const [sigma, stake] = v.array;
                if (!(stake instanceof CborUInt)) continue;
                unPools.push([PoolKeyHash.fromCborObj(k), {
                    stake: stake.num,
                    sigma: sigma as Rational
                }]);
            }
        }

        return new PoolDistr(unPools, totalStake.num);
    }
}

// Stashed AVVM Addresses
export interface IStashedAVVMAddresses {
    get addresses(): UTxO[];
    set addresses(a: UTxO[]);
}

export class StashedAVVMAddresses implements IStashedAVVMAddresses {
    private _addresses: UTxO[];

    constructor(addresses: UTxO[]) {
        this._addresses = addresses;
    }

    get addresses(): UTxO[] { return this._addresses; }
    set addresses(a: UTxO[]) { this._addresses = a; }

    toCborObj(): CborObj {
        return new CborMap([]); // Simplified
    }

    static fromCborObj(cborObj: CborObj): StashedAVVMAddresses {
        return new StashedAVVMAddresses([]);
    }
}

// New Epoch State Interface
export interface INewEpochState {
    get lastEpochModified(): Epoch;
    set lastEpochModified(value: Epoch);

    get prevBlocks(): IBlocksMade;
    set prevBlocks(value: IBlocksMade);

    get currBlocks(): IBlocksMade;
    set currBlocks(value: IBlocksMade);

    get epochState(): IEpochState;
    set epochState(value: IEpochState);

    get pulsingRewUpdate(): IPulsingRewUpdate;
    set pulsingRewUpdate(value: IPulsingRewUpdate);

    get poolDistr(): IPoolDistr;
    set poolDistr(value: IPoolDistr);

    get stashedAvvmAddresses(): IStashedAVVMAddresses;
    set stashedAvvmAddresses(value: IStashedAVVMAddresses);
}

// SQL-backed NewEpochState implementation with field-by-field database operations
export class SQLNewEpochState implements INewEpochState {
    private epochNo: number;
    private _lastEpochModified?: bigint;
    private _prevBlocks?: BlocksMade;
    private _currBlocks?: BlocksMade;
    private _epochState?: EpochState;
    private _pulsingRewUpdate?: PulsingRewUpdate;
    private _poolDistr?: PoolDistr;
    private _stashedAvvmAddresses?: StashedAVVMAddresses;

    constructor(epochNo: number) {
        this.epochNo = epochNo;
    }

    // INewEpochState interface implementation with database-backed getters/setters

    get lastEpochModified(): bigint {
        if (this._lastEpochModified === undefined) {
            throw new Error("lastEpochModified not loaded. Use load() or create() first.");
        }
        return this._lastEpochModified;
    }

    set lastEpochModified(value: bigint) {
        this._lastEpochModified = value;
        // Update metadata in database
        this.updateMetadata();
    }

    get prevBlocks(): BlocksMade {
        if (!this._prevBlocks) {
            throw new Error("prevBlocks not loaded");
        }
        return this._prevBlocks;
    }

    set prevBlocks(value: BlocksMade) {
        this._prevBlocks = value;
        this.saveBlocksMade(false);
    }

    get currBlocks(): BlocksMade {
        if (!this._currBlocks) {
            throw new Error("currBlocks not loaded");
        }
        return this._currBlocks;
    }

    set currBlocks(value: BlocksMade) {
        this._currBlocks = value;
        this.saveBlocksMade(true);
    }

    get epochState(): EpochState {
        if (!this._epochState) {
            throw new Error("epochState not loaded");
        }
        return this._epochState;
    }

    set epochState(value: EpochState) {
        this._epochState = value;
        this.saveEpochState();
    }

    get pulsingRewUpdate(): PulsingRewUpdate {
        if (!this._pulsingRewUpdate) {
            throw new Error("pulsingRewUpdate not loaded");
        }
        return this._pulsingRewUpdate;
    }

    set pulsingRewUpdate(value: PulsingRewUpdate) {
        this._pulsingRewUpdate = value;
        this.saveRewards();
    }

    get poolDistr(): PoolDistr {
        if (!this._poolDistr) {
            throw new Error("poolDistr not loaded");
        }
        return this._poolDistr;
    }

    set poolDistr(value: PoolDistr) {
        this._poolDistr = value;
        this.savePoolDistr();
    }

    get stashedAvvmAddresses(): StashedAVVMAddresses {
        if (!this._stashedAvvmAddresses) {
            throw new Error("stashedAvvmAddresses not loaded");
        }
        return this._stashedAvvmAddresses;
    }

    set stashedAvvmAddresses(value: StashedAVVMAddresses) {
        this._stashedAvvmAddresses = value;
        this.saveStashedAVVM();
    }

    // Database operations

    private async updateMetadata(): Promise<void> {
        // Update the metadata in database
        // For now, we don't have a specific update method, so we recreate
        await createNES(this.epochNo, Number(this._lastEpochModified || this.epochNo));
    }

    private async saveBlocksMade(isCurrent: boolean): Promise<void> {
        const blocks = isCurrent ? this._currBlocks : this._prevBlocks;
        if (!blocks) return;

        const blocksMade: Record<string, number> = {};
        for (const [poolHash, count] of blocks.value) {
            blocksMade[poolHash.toString('hex')] = Number(count);
        }

        await saveBlocksMade(this.epochNo, blocksMade, isCurrent);
    }

    private async saveEpochState(): Promise<void> {
        if (!this._epochState) return;

        // Save chain account
        await saveChainAccount(
            this.epochNo,
            BigInt(this._epochState.chainAccountState.treasury),
            BigInt(this._epochState.chainAccountState.reserves)
        );

        // Save UTxO
        const utxos = this._epochState.ledgerState.utxoState.utxo.map(utxo => ({
            txHash: utxo.utxoRef.id.toString(),
            txIndex: utxo.utxoRef.index,
            address: utxo.resolved.address.toString(),
            amount: utxo.resolved.value.lovelaces,
            datumHash: utxo.resolved.datum?.toString(),
            scriptRef: utxo.resolved.refScript?.toString(),
        }));

        await saveUTxO(this.epochNo, utxos);
        await saveUTxOState(
            this.epochNo,
            BigInt(this._epochState.ledgerState.utxoState.deposited),
            BigInt(this._epochState.ledgerState.utxoState.fees),
            BigInt(this._epochState.ledgerState.utxoState.donation)
        );

        // Save snapshots
        await this.saveSnapshots();

        // Save non-myopic
        await this.saveNonMyopic();
    }

    private async saveSnapshots(): Promise<void> {
        if (!this._epochState?.snapshots) return;

        const snapshots = this._epochState.snapshots;

        // Save stake for each snapshot type
        await this.saveSnapshotStake(snapshots.mark, 'mark');
        await this.saveSnapshotStake(snapshots.set, 'set');
        await this.saveSnapshotStake(snapshots.go, 'go');

        // Save delegations for each snapshot type
        await this.saveSnapshotDelegations(snapshots.mark, 'mark');
        await this.saveSnapshotDelegations(snapshots.set, 'set');
        await this.saveSnapshotDelegations(snapshots.go, 'go');

        // Save pool params for each snapshot type
        await this.saveSnapshotPoolParams(snapshots.mark, 'mark');
        await this.saveSnapshotPoolParams(snapshots.set, 'set');
        await this.saveSnapshotPoolParams(snapshots.go, 'go');

        // Save snapshot metadata
        await saveSnapshotsMeta(
            this.epochNo,
            BigInt(snapshots.fee),
            BigInt(snapshots.fee),
            BigInt(snapshots.fee)
        );
    }

    private async saveSnapshotStake(snapshot: Snapshot, type: string): Promise<void> {
        const stake: [Uint8Array, bigint][] = Array.from(snapshot.stake.stake.entries())
            .map(([creds, amount]: [StakeCredentials, Coin]) => [creds.toCbor().toBuffer(), BigInt(amount)]);
        await saveStake(this.epochNo, stake, type);
    }

    private async saveSnapshotDelegations(snapshot: Snapshot, type: string): Promise<void> {
        const delegations: [Uint8Array, Uint8Array][] = Array.from(snapshot.delegations.delegations.entries())
            .map(([creds, poolHash]: [StakeCredentials, PoolKeyHash]) => [creds.toCbor().toBuffer(), poolHash.toCbor().toBuffer()]);
        await saveDelegations(this.epochNo, delegations, type);
    }

    private async saveSnapshotPoolParams(snapshot: Snapshot, type: string): Promise<void> {
        const poolParams: [Uint8Array, any][] = Array.from(snapshot.poolParams.pparams.entries())
            .map(([poolHash, params]: [PoolKeyHash, any]) => [poolHash.toCbor().toBuffer(), {
                vrfKeyHash: params.vrfKeyHash.toString('hex'),
                pledge: params.pledge,
                cost: params.cost,
                marginNumerator: params.margin.numerator,
                marginDenominator: params.margin.denominator,
                rewardAccount: params.rewardAccount.toCbor().toBuffer(),
                owners: params.owners.map((owner: any) => owner.toString('hex')),
                relays: params.relays.map((relay: any) => ({
                    type: relay.type,
                    ipv4: relay.ipv4,
                    ipv6: relay.ipv6,
                    dns: relay.dnsName,
                    port: relay.port,
                })),
                metadataUrl: params.metadata?.url,
                metadataHash: params.metadata?.hash?.toString('hex'),
            }]);
        await savePoolParams(this.epochNo, poolParams, type);
    }

    private async saveNonMyopic(): Promise<void> {
        if (!this._epochState?.nonMyopic) return;

        // Serialize likelihoods map
        const likelihoods = new Uint8Array(0); // TODO: Implement proper serialization
        await saveNonMyopic(this.epochNo, likelihoods, BigInt(this._epochState.nonMyopic.rewardPot));
    }

    private async saveRewards(): Promise<void> {
        if (!this._pulsingRewUpdate) return;

        // Convert rewards to database format
        const rewards: any[] = []; // TODO: Implement proper reward serialization
        await saveRewards(this.epochNo, rewards);
    }

    private async savePoolDistr(): Promise<void> {
        if (!this._poolDistr) return;

        const poolDistr: [Uint8Array, { stake: bigint; sigma: number }][] =
            Array.from(this._poolDistr.unPools.entries()).map(([poolHash, distr]: [PoolKeyHash, any]) => [poolHash.toCbor().toBuffer(), {
                stake: distr.individualTotalPoolStake,
                sigma: Number(distr.individualPoolStake.numerator) / Number(distr.individualPoolStake.denominator)
            }]);

        await savePoolDistr(this.epochNo, poolDistr, BigInt(this._poolDistr.totalStake));
    }

    private async saveStashedAVVM(): Promise<void> {
        if (!this._stashedAvvmAddresses) return;

        const addresses = this._stashedAvvmAddresses.addresses.map((utxo: UTxO) => utxo.toCbor().toBuffer());
        await saveStashedAVVM(this.epochNo, addresses);
    }

    // Loading methods

    private async loadBlocksMade(isCurrent: boolean): Promise<BlocksMade> {
        const blocksMade = await loadBlocksMade(this.epochNo, isCurrent);
        const array: [PoolKeyHash, bigint][] = [];
        for (const [hex, count] of Object.entries(blocksMade)) {
            array.push([new PoolKeyHash(Uint8Array.from(Buffer.from(hex, 'hex'))), BigInt(count)]);
        }
        return new BlocksMade(array);
    }

    private async loadChainAccount(): Promise<ChainAccountState> {
        const account = await loadChainAccount(this.epochNo);
        if (!account) {
            return new ChainAccountState(0n, 0n);
        }
        return new ChainAccountState(BigInt(account.treasury), BigInt(account.reserves));
    }

    private async loadUTxOState(): Promise<UTxOState> {
        const data = await loadUTxO(this.epochNo);
        const utxos = data.utxos.map((utxo: any) =>
            new UTxO({
                utxoRef: new TxOutRef({
                    id: new Hash32(Uint8Array.from(Buffer.from(utxo.tx_hash, 'hex'))),
                    index: utxo.tx_index
                }),
                resolved: new TxOut({
                    address: utxo.address as any, // TODO: Parse address properly
                    value: { lovelaces: BigInt(utxo.amount) } as any,
                    datum: utxo.datum_hash ? new Hash32(utxo.datum_hash) : undefined,
                    refScript: utxo.script_ref ? Script.fromCbor(Buffer.from(utxo.script_ref, 'hex')) : undefined,
                })
            })
        );

        const state = data.state;
        return new UTxOState(
            utxos,
            state ? BigInt(state.deposited) : 0n,
            state ? BigInt(state.fees) : 0n,
            undefined, // govState
            undefined, // instantStake
            state ? BigInt(state.donation) : 0n
        );
    }

    private async loadSnapshots(): Promise<Snapshots> {
        // Load stake, delegations, and pool params for each snapshot type
        const markStake = await this.loadSnapshotStake('mark');
        const setStake = await this.loadSnapshotStake('set');
        const goStake = await this.loadSnapshotStake('go');

        const markDelegations = await this.loadSnapshotDelegations('mark');
        const setDelegations = await this.loadSnapshotDelegations('set');
        const goDelegations = await this.loadSnapshotDelegations('go');

        const markPoolParams = await this.loadSnapshotPoolParams('mark');
        const setPoolParams = await this.loadSnapshotPoolParams('set');
        const goPoolParams = await this.loadSnapshotPoolParams('go');

        const meta = await loadSnapshotsMeta(this.epochNo);

        return new Snapshots(
            new Snapshot(markStake, markDelegations, markPoolParams),
            new Snapshot(setStake, setDelegations, setPoolParams),
            new Snapshot(goStake, goDelegations, goPoolParams),
            meta ? BigInt(meta.markFee) : 0n
        );
    }

    private async loadSnapshotStake(type: string): Promise<Stake> {
        const stakeData = await loadStake(this.epochNo, type);
        const stake = new Map<StakeCredentials, Coin>();
        for (const [credsBytes, amount] of stakeData) {
            const creds = StakeCredentials.fromCbor(credsBytes);
            stake.set(creds, BigInt(amount));
        }
        return new Stake(Array.from(stake.entries()));
    }

    private async loadSnapshotDelegations(type: string): Promise<Delegations> {
        const delegationsData = await loadDelegations(this.epochNo, type);
        const delegations = new Map<StakeCredentials, PoolKeyHash>();
        for (const [credsBytes, poolHashBytes] of delegationsData) {
            const creds = StakeCredentials.fromCbor(credsBytes);
            const poolHash = PoolKeyHash.fromCbor(poolHashBytes);
            delegations.set(creds, poolHash);
        }
        return new Delegations(Array.from(delegations.entries()));
    }

    private async loadSnapshotPoolParams(type: string): Promise<PParams> {
        const poolParamsData = await loadPoolParams(this.epochNo, type);
        const pparams = new Map<PoolKeyHash, any>();
        for (const [poolHashBytes, params] of poolParamsData) {
            const poolHash = PoolKeyHash.fromCbor(poolHashBytes);
            // TODO: Reconstruct PoolParams from stored data
            // This is a placeholder
            pparams.set(poolHash, {} as any);
        }
        return new PParams(Array.from(pparams.entries()));
    }

    private async loadNonMyopicData(): Promise<NonMyopic> {
        const data = await loadNonMyopic(this.epochNo);
        if (!data) {
            return new NonMyopic(0n);
        }
        // TODO: Deserialize likelihoods
        return new NonMyopic(BigInt(data.rewardPot));
    }

    private async loadRewardsData(): Promise<PulsingRewUpdate> {
        const rewards = await loadRewards(this.epochNo);
        // TODO: Reconstruct PulsingRewUpdate from rewards data
        return new PulsingRewUpdate();
    }

    private async loadPoolDistrData(): Promise<PoolDistr> {
        const data = await loadPoolDistr(this.epochNo);
        // TODO: Reconstruct PoolDistr from data
        return new PoolDistr([], BigInt(data.totalStake));
    }

    private async loadStashedAVVMData(): Promise<StashedAVVMAddresses> {
        const addresses = await loadStashedAVVM(this.epochNo);
        // TODO: Reconstruct addresses from bytes
        return new StashedAVVMAddresses([]);
    }

    // Factory methods
    static async create(epochNo: number): Promise<SQLNewEpochState> {
        const instance = new SQLNewEpochState(epochNo);
        await createNES(epochNo, epochNo);

        // Initialize with default values
        instance._lastEpochModified = BigInt(epochNo);
        instance._prevBlocks = new BlocksMade([]);
        instance._currBlocks = new BlocksMade([]);
        instance._epochState = new EpochState(
            new ChainAccountState(0n, 0n),
            new LedgerState(
                new UTxOState([], 0n, 0n, 0n)
            ),
            new Snapshots(
                new Snapshot(new Stake([]), new Delegations([]), new PParams([])),
                new Snapshot(new Stake([]), new Delegations([]), new PParams([])),
                new Snapshot(new Stake([]), new Delegations([]), new PParams([])),
                0n
            ),
            new NonMyopic(0n)
        );
        instance._pulsingRewUpdate = new PulsingRewUpdate();
        instance._poolDistr = new PoolDistr([], 0n);
        instance._stashedAvvmAddresses = new StashedAVVMAddresses([]);

        return instance;
    }

    static async load(epochNo: number): Promise<SQLNewEpochState | null> {
        const result = await loadNES(epochNo);
        if (!result.exists) return null;

        const instance = new SQLNewEpochState(epochNo);
        instance._lastEpochModified = BigInt(result.metadata.last_epoch_modified);

        // Load all components
        await instance.loadAllComponents();

        return instance;
    }

    private async loadAllComponents(): Promise<void> {
        // Load all components from database
        this._prevBlocks = await this.loadBlocksMade(false);
        this._currBlocks = await this.loadBlocksMade(true);

        // Load epoch state components
        const chainAccount = await this.loadChainAccount();
        const utxoState = await this.loadUTxOState();
        const snapshots = await this.loadSnapshots();
        const nonMyopic = await this.loadNonMyopicData();

        this._epochState = new EpochState(
            chainAccount,
            new LedgerState(utxoState),
            snapshots,
            nonMyopic
        );

        this._pulsingRewUpdate = await this.loadRewardsData();
        this._poolDistr = await this.loadPoolDistrData();
        this._stashedAvvmAddresses = await this.loadStashedAVVMData();
    }

    // CBOR compatibility
    static async fromCborObj(cborObj: CborObj): Promise<SQLNewEpochState> {
        // Parse to get epoch number
        // Since we don't have RawNewEpochState, we'll create a simple parser
        if (!(cborObj instanceof CborArray) || cborObj.array.length < 1) throw new Error("Invalid CBOR for NewEpochState");
        const epochNo = Number(cborObj.array[0] instanceof CborUInt ? cborObj.array[0].num : 0);

        // Create instance and populate from CBOR
        const instance = await this.create(epochNo);
        // TODO: Parse full CBOR and populate fields

        return instance;
    }

    toCborObj(): CborObj {
        // TODO: Implement proper CBOR serialization
        throw new Error("CBOR serialization not implemented yet");
    }
}