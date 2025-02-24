
export interface NodeConfig {
    readonly networkMagic: number;
    readonly ledgerStatePath: string;
    readonly volatileDbPath: string;
    readonly immutableDbPath: string;
    readonly startPoint : {
        blockHeader: {
            hash: string;
            slot: number;
        };
    }
}