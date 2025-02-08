

export enum MasterMessageKind {
    InitChainSel,
    ChainSelMessage,
}

export interface MasterMessage<K extends MasterMessageKind = MasterMessageKind> {
    kind: K,
    data: MasterMessageData<K>
}

export type MasterMessageData<K extends MasterMessageKind> =
    K extends MasterMessageKind.InitChainSel ? InitChainSelData
    : K extends MasterMessageKind.ChainSelMessage ? ChainSelMessageData
    : never;

export interface InitChainSelData {}


export enum ChainSelMessageKind {
    NewPeer
}

export interface ChainSelMessageData<K extends ChainSelMessageKind = ChainSelMessageKind> {
    kind: K,
    message: ChainSelMessage<K>
}

export type ChainSelMessage<K extends ChainSelMessageKind> =
    K extends ChainSelMessageKind.NewPeer ? NewPeerData
    : never;

export interface NewPeerData {
    peerId: number,
    port: MessagePort
}