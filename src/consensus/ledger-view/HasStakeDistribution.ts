export interface PoolInfos {
    vrfKeyHash: Uint8Array;
    /** stake at work during the epoch (2 epochs earlier `currentStake`) **/
    activeStake: bigint;
    /**
     * Stake of the underlying pool. The ratio currentStake/activeStake gives the pool's relative stake.
     */
    currentStake: bigint;
}

export interface HasStakeDistribution {
    /**
     * get infos about a pool at a given slot
     */
    getPoolInfos(
        absolute_slot: bigint,
        poolId: Uint8Array,
    ): Promise<PoolInfos | undefined>;

    /**
     * slot => kes period
     */
    slotToKesPeriod(absolute_slot: bigint): Promise<bigint>;

    /**
     * read max kes evolutions
     */
    maxKesEvolution(): Promise<bigint>;

    /**
     * get the latest operational certificate number (`node.counter`)
     */
    getLatestOpCertNumber(poolId: Uint8Array): Promise<bigint>;
}
