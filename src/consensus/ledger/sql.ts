class SqlStorage {
    private worker: Worker;
    private idCounter = 0;
    private pendingPromises = new Map<number, (value: any) => void>();

    constructor() {
        this.worker = new Worker("./src/consensus/ledger/sqlWorker.ts");
        this.worker.addEventListener("message", (msg: any) => {
            if (msg.type === "done") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(undefined);
                    this.pendingPromises.delete(msg.id);
                }
            } else if (msg.type === "result") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(msg.data);
                    this.pendingPromises.delete(msg.id);
                }
            } else if (msg.type === "error") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(Promise.reject(new Error(msg.error)));
                    this.pendingPromises.delete(msg.id);
                }
            }
        });
    }

    async createNES(epochNo: number, lastEpochModified: number, slotsPerKESPeriod: number, maxKESEvolutions: number): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "createNES",
            epochNo,
            lastEpochModified,
            slotsPerKESPeriod,
            maxKESEvolutions,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadNES(epochNo: number): Promise<{ exists: boolean; metadata?: any }> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadNES",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveBlocksMade(epochNo: number, blocksMade: Record<string, number>, isCurrent: boolean): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveBlocksMade",
            epochNo,
            blocksMade,
            isCurrent,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadBlocksMade(epochNo: number, isCurrent: boolean): Promise<Record<string, number>> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadBlocksMade",
            epochNo,
            isCurrent,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveChainAccount(epochNo: number, treasury: bigint, reserves: bigint): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveChainAccount",
            epochNo,
            treasury,
            reserves,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadChainAccount(epochNo: number): Promise<{ treasury: bigint; reserves: bigint } | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadChainAccount",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveUTxO(epochNo: number, utxos: any[]): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveUTxO",
            epochNo,
            utxos,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveUTxOState(epochNo: number, deposited: bigint, fees: bigint, donation: bigint): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveUTxOState",
            epochNo,
            deposited,
            fees,
            donation,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadUTxO(epochNo: number): Promise<{ utxos: any[]; state: any }> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadUTxO",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveStake(epochNo: number, stake: [Uint8Array, bigint][], snapshotType: string): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveStake",
            epochNo,
            stake,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadStake(epochNo: number, snapshotType: string): Promise<[Uint8Array, bigint][]> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadStake",
            epochNo,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveDelegations(epochNo: number, delegations: [Uint8Array, Uint8Array][], snapshotType: string): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveDelegations",
            epochNo,
            delegations,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadDelegations(epochNo: number, snapshotType: string): Promise<[Uint8Array, Uint8Array][]> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadDelegations",
            epochNo,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async savePoolParams(epochNo: number, poolParams: [Uint8Array, any][], snapshotType: string): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "savePoolParams",
            epochNo,
            poolParams,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadPoolParams(epochNo: number, snapshotType: string): Promise<[Uint8Array, any][]> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadPoolParams",
            epochNo,
            snapshotType,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async savePoolDistr(epochNo: number, poolDistr: [Uint8Array, { stake: bigint; sigma: number }][], totalStake: bigint): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "savePoolDistr",
            epochNo,
            poolDistr,
            totalStake,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadPoolDistr(epochNo: number): Promise<{ poolDistr: [Uint8Array, { stake: bigint; sigma: number }][]; totalStake: bigint }> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadPoolDistr",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveRewards(epochNo: number, rewards: any[]): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveRewards",
            epochNo,
            rewards,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadRewards(epochNo: number): Promise<any[]> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadRewards",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveNonMyopic(epochNo: number, likelihoods: Uint8Array, rewardPot: bigint): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveNonMyopic",
            epochNo,
            likelihoods,
            rewardPot,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadNonMyopic(epochNo: number): Promise<{ likelihoods: Uint8Array; rewardPot: bigint } | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadNonMyopic",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveStashedAVVM(epochNo: number, addresses: Uint8Array[]): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveStashedAVVM",
            epochNo,
            addresses,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadStashedAVVM(epochNo: number): Promise<Uint8Array[]> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadStashedAVVM",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async saveSnapshotsMeta(epochNo: number, markFee: bigint, setFee: bigint, goFee: bigint): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "saveSnapshotsMeta",
            epochNo,
            markFee,
            setFee,
            goFee,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async loadSnapshotsMeta(epochNo: number): Promise<{ markFee: bigint; setFee: bigint; goFee: bigint } | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "loadSnapshotsMeta",
            epochNo,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async closeDB(): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "closeDB", id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    terminate(): void {
        this.worker.terminate();
    }
}

// Create an instance for the exports
const storage = new SqlStorage();

export async function createNES(epochNo: number, lastEpochModified: number = epochNo, slotsPerKESPeriod: number = 1, maxKESEvolutions: number = 1): Promise<void> {
    return storage.createNES(epochNo, lastEpochModified, slotsPerKESPeriod, maxKESEvolutions);
}

export async function loadNES(epochNo: number): Promise<{ exists: boolean; metadata?: any }> {
    return storage.loadNES(epochNo);
}

export async function saveBlocksMade(epochNo: number, blocksMade: Record<string, number>, isCurrent: boolean): Promise<void> {
    return storage.saveBlocksMade(epochNo, blocksMade, isCurrent);
}

export async function loadBlocksMade(epochNo: number, isCurrent: boolean): Promise<Record<string, number>> {
    return storage.loadBlocksMade(epochNo, isCurrent);
}

export async function saveChainAccount(epochNo: number, treasury: bigint, reserves: bigint): Promise<void> {
    return storage.saveChainAccount(epochNo, treasury, reserves);
}

export async function loadChainAccount(epochNo: number): Promise<{ treasury: bigint; reserves: bigint } | null> {
    return storage.loadChainAccount(epochNo);
}

export async function saveUTxO(epochNo: number, utxos: any[]): Promise<void> {
    return storage.saveUTxO(epochNo, utxos);
}

export async function saveUTxOState(epochNo: number, deposited: bigint, fees: bigint, donation: bigint): Promise<void> {
    return storage.saveUTxOState(epochNo, deposited, fees, donation);
}

export async function loadUTxO(epochNo: number): Promise<{ utxos: any[]; state: any }> {
    return storage.loadUTxO(epochNo);
}

export async function saveStake(epochNo: number, stake: [Uint8Array, bigint][], snapshotType: string): Promise<void> {
    return storage.saveStake(epochNo, stake, snapshotType);
}

export async function loadStake(epochNo: number, snapshotType: string): Promise<[Uint8Array, bigint][]> {
    return storage.loadStake(epochNo, snapshotType);
}

export async function saveDelegations(epochNo: number, delegations: [Uint8Array, Uint8Array][], snapshotType: string): Promise<void> {
    return storage.saveDelegations(epochNo, delegations, snapshotType);
}

export async function loadDelegations(epochNo: number, snapshotType: string): Promise<[Uint8Array, Uint8Array][]> {
    return storage.loadDelegations(epochNo, snapshotType);
}

export async function savePoolParams(epochNo: number, poolParams: [Uint8Array, any][], snapshotType: string): Promise<void> {
    return storage.savePoolParams(epochNo, poolParams, snapshotType);
}

export async function loadPoolParams(epochNo: number, snapshotType: string): Promise<[Uint8Array, any][]> {
    return storage.loadPoolParams(epochNo, snapshotType);
}

export async function savePoolDistr(epochNo: number, poolDistr: [Uint8Array, { stake: bigint; sigma: number }][], totalStake: bigint): Promise<void> {
    return storage.savePoolDistr(epochNo, poolDistr, totalStake);
}

export async function loadPoolDistr(epochNo: number): Promise<{ poolDistr: [Uint8Array, { stake: bigint; sigma: number }][]; totalStake: bigint }> {
    return storage.loadPoolDistr(epochNo);
}

export async function saveRewards(epochNo: number, rewards: any[]): Promise<void> {
    return storage.saveRewards(epochNo, rewards);
}

export async function loadRewards(epochNo: number): Promise<any[]> {
    return storage.loadRewards(epochNo);
}

export async function saveNonMyopic(epochNo: number, likelihoods: Uint8Array, rewardPot: bigint): Promise<void> {
    return storage.saveNonMyopic(epochNo, likelihoods, rewardPot);
}

export async function loadNonMyopic(epochNo: number): Promise<{ likelihoods: Uint8Array; rewardPot: bigint } | null> {
    return storage.loadNonMyopic(epochNo);
}

export async function saveStashedAVVM(epochNo: number, addresses: Uint8Array[]): Promise<void> {
    return storage.saveStashedAVVM(epochNo, addresses);
}

export async function loadStashedAVVM(epochNo: number): Promise<Uint8Array[]> {
    return storage.loadStashedAVVM(epochNo);
}

export async function saveSnapshotsMeta(epochNo: number, markFee: bigint, setFee: bigint, goFee: bigint): Promise<void> {
    return storage.saveSnapshotsMeta(epochNo, markFee, setFee, goFee);
}

export async function loadSnapshotsMeta(epochNo: number): Promise<{ markFee: bigint; setFee: bigint; goFee: bigint } | null> {
    return storage.loadSnapshotsMeta(epochNo);
}

export async function closeDB(): Promise<void> {
    await storage.closeDB();
    storage.terminate();
}