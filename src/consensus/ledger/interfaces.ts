// Core NES interfaces for dual implementation architecture

import { CborObj } from '@harmoniclabs/cbor';

// Base interfaces that both Raw* and SQL* implementations must satisfy

export interface INewEpochState {
  readonly lastEpochModified: number | bigint;
  readonly epochState: IEpochState;
  readonly rewardsUpdate: any; // IRewardsUpdate
  readonly poolDistr: any; // IPoolDistr
  readonly stashedAVVMAddresses: any; // IStashedAVVMAddresses

  toCborObj(): CborObj;
}

export interface IEpochState {
  readonly chainAccountState: any; // IChainAccountState
  readonly ledgerState: ILedgerState;
  readonly snapshots: ISnapshots;
  readonly nonMyopic: any; // INonMyopic
}

export interface ILedgerState {
  readonly utxoState: IUTxOState;
  // ... other ledger state components
}

export interface ISnapshots {
  readonly stakeMark: ISnapshot;
  readonly stakeSet: ISnapshot;
  readonly stakeGo: ISnapshot;
}

export interface ISnapshot {
  readonly stake: any; // IStake
  readonly delegations: any; // IDelegations
  readonly poolParams: any; // IPParams
}

export interface IUTxOState {
  readonly utxo: any; // IUTxO
  readonly fees: any; // Value
  // ... other UTxO state components
}

// Factory pattern for implementation selection
export enum NESImplementation {
  RAW = 'raw',
  SQL = 'sql'
}

export interface NESFactory {
  createNewEpochState(data: any): Promise<INewEpochState>;
  getImplementationType(): NESImplementation;
}

// Type guards for runtime implementation checking
export function isRawImplementation(nes: INewEpochState): nes is RawNewEpochState {
  return (nes as any).implementation === NESImplementation.RAW;
}

export function isSQLImplementation(nes: INewEpochState): nes is SQLNewEpochState {
  return (nes as any).implementation === NESImplementation.SQL;
}

// Forward declarations for circular dependencies
export interface RawNewEpochState extends INewEpochState {
  readonly implementation: NESImplementation.RAW;
}

export interface SQLNewEpochState extends INewEpochState {
  readonly implementation: NESImplementation.SQL;
}