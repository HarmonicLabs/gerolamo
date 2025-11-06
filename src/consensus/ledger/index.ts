import { SQL } from "bun";
import {
    Coin,
    ConwayUTxO,
    Hash28,
    PoolKeyHash,
    StakeCredentials,
} from "@harmoniclabs/cardano-ledger-ts";
import {
    Cbor,
    CborArray,
    CborBytes,
    CborMap,
    CborObj,
    CborUInt,
} from "@harmoniclabs/cbor";
import { logger } from "../../utils/logger";

// Ported from rawNES
import { Rational, VRFKeyHash } from "@harmoniclabs/cardano-ledger-ts";
import { CborPositiveRational } from "@harmoniclabs/cbor";

interface IIndividualPoolStake {
    get individualPoolStake(): Rational;
    set individualPoolStake(ips: Rational);

    get individualTotalPoolStake(): Coin;
    set individualTotalPoolStake(itps: Coin);

    get individualPoolStakeVrf(): VRFKeyHash;
    set individualPoolStakeVrf(ipsv: VRFKeyHash);
}

class RawIndividualPoolStake implements IIndividualPoolStake {
    _individualPoolStake: Rational;
    _individualTotalPoolStake: Coin;
    _individualPoolStakeVrf: VRFKeyHash;

    constructor(
        ips: Rational,
        itps: Coin,
        ipsv: VRFKeyHash,
    ) {
        this._individualPoolStake = ips;
        this._individualTotalPoolStake = itps;
        this._individualPoolStakeVrf = ipsv;
    }

    static fromCborObj(v: CborObj): RawIndividualPoolStake {
        if (!(v instanceof CborArray)) throw new Error();
        if ((v as CborArray).array.length !== 3) throw new Error();

        const [iPS, individualTotalPoolStake, individualPoolStakeVrf] =
            (v as CborArray).array;
        const individualPoolStake = CborPositiveRational
            .fromCborObjOrUndef(
                iPS,
            );
        if (individualPoolStake === undefined) throw new Error();

        return new RawIndividualPoolStake(
            individualPoolStake,
            decodeCoin(
                individualTotalPoolStake,
            ),
            VRFKeyHash.fromCborObj(
                individualPoolStakeVrf,
            ),
        );
    }

    get individualPoolStake(): Rational {
        return this._individualPoolStake;
    }

    set individualPoolStake(v: Rational) {
        this._individualPoolStake = v;
    }

    get individualTotalPoolStake(): Coin {
        return this._individualTotalPoolStake;
    }
    set individualTotalPoolStake(itps: Coin) {
        this._individualTotalPoolStake = itps;
    }

    get individualPoolStakeVrf(): VRFKeyHash {
        return this._individualPoolStakeVrf;
    }
    set individualPoolStakeVrf(ipsv: VRFKeyHash) {
        this._individualPoolStakeVrf = ipsv;
    }
}

function decodeCoin(cbor: CborObj): Coin {
    if (!(cbor instanceof CborUInt)) throw new Error();
    return BigInt((cbor as CborUInt).num);
}

type _PoolDistr = [PoolKeyHash, IIndividualPoolStake][];

interface IPoolDistr {
    get unPoolDistr(): _PoolDistr;
    set unPoolDistr(pd: _PoolDistr);

    get totalActiveStake(): Coin;
    set totalActiveStake(tas: Coin);
}

export class RawPoolDistr implements IPoolDistr {
    _unPoolDistr: _PoolDistr;
    _pdTotalActiveStake: Coin;

    constructor(unPoolDistr: _PoolDistr, pdActiveTotalStake: Coin) {
        this._unPoolDistr = unPoolDistr;
        this._pdTotalActiveStake = pdActiveTotalStake;
    }

    static fromCborObj(cborObj: CborObj): RawPoolDistr {
        if (!(cborObj instanceof CborArray)) throw new Error();
        if ((cborObj as CborArray).array.length !== 2) throw new Error();

        const [unPoolDistr, pdTotalActiveStake] = (cborObj as CborArray).array;
        if (!(unPoolDistr instanceof CborMap)) throw new Error();

        return new RawPoolDistr(
            (unPoolDistr as CborMap).map.map(({ k, v }) => {
                return [
                    PoolKeyHash.fromCborObj(k),
                    RawIndividualPoolStake.fromCborObj(v),
                ];
            }),
            decodeCoin(pdTotalActiveStake),
        );
    }

    get unPoolDistr(): _PoolDistr {
        return this._unPoolDistr;
    }
    set unPoolDistr(pd: _PoolDistr) {
        this._unPoolDistr = pd;
    }

    get totalActiveStake(): Coin {
        return this._pdTotalActiveStake;
    }
    set totalActiveStake(tas: Coin) {
        this._pdTotalActiveStake = tas;
    }
}
// Skeleton classes for interacting with the NewEpochState SQLite schema

export class SQLNewEpochState {
    db: SQL;
    private dbPath: string;

    constructor(dbOrPath: string | SQL) {
        if (typeof dbOrPath === "string") {
            this.dbPath = dbOrPath;
            this.db = new SQL(`file:${dbOrPath}`);
        } else {
            this.db = dbOrPath;
            this.dbPath = "";
        }
    }

    async init(): Promise<void> {
        await this.initNewEpochState();
        await this.initBlocksMade();
        await this.initEpochState();
        await this.initPulsingRewUpdate();
        await this.initPoolDistr();
        await this.initAvvmAddresses();
    }

    private async initNewEpochState(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS new_epoch_state (
                epoch INTEGER PRIMARY KEY,
                last_epoch_modified INTEGER,
                slots_per_kes_period INTEGER DEFAULT 1,
                max_kes_evolutions INTEGER DEFAULT 1,
                epoch_state_id INTEGER,
                pulsing_rew_update_id INTEGER,
                pool_distr_id INTEGER,
                stashed_avvm_addresses_id INTEGER,
                FOREIGN KEY (epoch_state_id) REFERENCES epoch_state(id),
                FOREIGN KEY (pulsing_rew_update_id) REFERENCES pulsing_rew_update(id),
                FOREIGN KEY (pool_distr_id) REFERENCES pool_distr(id),
                FOREIGN KEY (stashed_avvm_addresses_id) REFERENCES stashed_avvm_addresses(id)
            );
        `;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_new_epoch_state_epoch_state_id ON new_epoch_state(epoch_state_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_new_epoch_state_pulsing_rew_update_id ON new_epoch_state(pulsing_rew_update_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_new_epoch_state_pool_distr_id ON new_epoch_state(pool_distr_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_new_epoch_state_stashed_avvm_addresses_id ON new_epoch_state(stashed_avvm_addresses_id)`;
    }

    private async initBlocksMade(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS blocks_made (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER,
                is_prev BOOLEAN,
                pool_hash BLOB,
                blocks INTEGER,
                FOREIGN KEY (epoch) REFERENCES new_epoch_state(epoch)
            );
        `;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_blocks_made_epoch ON blocks_made(epoch)`;
    }

    private async initEpochState(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS epoch_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chain_account_state_id INTEGER,
                ledger_state_id INTEGER,
                snapshots_id INTEGER,
                non_myopic_id INTEGER,
                FOREIGN KEY (chain_account_state_id) REFERENCES chain_account_state(id),
                FOREIGN KEY (ledger_state_id) REFERENCES ledger_state(id),
                FOREIGN KEY (snapshots_id) REFERENCES snapshots(id),
                FOREIGN KEY (non_myopic_id) REFERENCES non_myopic(id)
            );
        `;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_epoch_state_chain_account_state_id ON epoch_state(chain_account_state_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_epoch_state_ledger_state_id ON epoch_state(ledger_state_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_epoch_state_snapshots_id ON epoch_state(snapshots_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_epoch_state_non_myopic_id ON epoch_state(non_myopic_id)`;

        await this.db`
            CREATE TABLE IF NOT EXISTS chain_account_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                treasury INTEGER,
                reserves INTEGER
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS ledger_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                utxo BLOB,
                cert_state BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_id INTEGER,
                delegations_id INTEGER,
                pparams_id INTEGER,
                FOREIGN KEY (stake_id) REFERENCES stake(id),
                FOREIGN KEY (delegations_id) REFERENCES delegations(id),
                FOREIGN KEY (pparams_id) REFERENCES pparams(id)
            );
        `;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_snapshots_stake_id ON snapshots(stake_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_snapshots_delegations_id ON snapshots(delegations_id)`;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_snapshots_pparams_id ON snapshots(pparams_id)`;

        await this.db`
            CREATE TABLE IF NOT EXISTS stake (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_credential BLOB,
                amount INTEGER
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS delegations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_credential BLOB,
                pool_key_hash BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS pparams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                params BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS non_myopic (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                likelihoods_id INTEGER,
                reward_pot INTEGER,
                FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
            );
        `;
        await this
            .db`CREATE INDEX IF NOT EXISTS idx_non_myopic_likelihoods_id ON non_myopic(likelihoods_id)`;

        await this.db`
            CREATE TABLE IF NOT EXISTS likelihoods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_key_hash BLOB,
                likelihood_numerator INTEGER,
                likelihood_denominator INTEGER
            );
        `;
    }

    private async initPulsingRewUpdate(): Promise<void> {
        await this.db`            
            CREATE TABLE IF NOT EXISTS pulsing_rew_update (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    private async initPoolDistr(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS pool_distr (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    private async initAvvmAddresses(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    // Methods to get and set UTxO
    async getUTxO(): Promise<ConwayUTxO[]> {
        const result = await this.db`
            SELECT ls.utxo
            FROM ledger_state ls
            JOIN epoch_state es ON ls.id = es.ledger_state_id
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
        `;
        if (result.length === 0 || !result[0].utxo) return [];
        const bytes = result[0].utxo as Uint8Array;
        const cbor = Cbor.parse(bytes);
        if (!(cbor instanceof CborArray)) return [];
        return cbor.array.map((obj: CborObj) => ConwayUTxO.fromCborObj(obj));
    }

    async setUTxO(utxo: ConwayUTxO[]): Promise<void> {
        const cborArray = new CborArray(utxo.map((u) => u.toCborObj()));
        const bytes = Cbor.encode(cborArray);
        await this.db`
            UPDATE ledger_state
            SET utxo = ${bytes}
            FROM epoch_state es
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
            WHERE ledger_state.id = es.ledger_state_id
        `;
    }

    // Methods to get and set treasury
    async getTreasury(): Promise<bigint> {
        const result = await this.db`
            SELECT cas.treasury
            FROM chain_account_state cas
            JOIN epoch_state es ON cas.id = es.chain_account_state_id
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
        `;
        return result.length > 0 ? BigInt(result[0].treasury as number) : 0n;
    }

    async setTreasury(treasury: bigint): Promise<void> {
        await this.db`
            UPDATE chain_account_state
            SET treasury = ${treasury}
            FROM epoch_state es
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
            WHERE chain_account_state.id = es.chain_account_state_id
        `;
    }

    // Methods for stake
    async getStake(): Promise<Map<StakeCredentials, Coin>> {
        const result = await this.db`
            SELECT s.stake_credential, s.amount
            FROM stake s
        `;
        const stake = new Map<StakeCredentials, Coin>();
        for (const row of result) {
            const cred = StakeCredentials.fromCbor(row.stake_credential);
            stake.set(cred, BigInt(row.amount as number));
        }
        return stake;
    }

    async setStake(stake: Map<StakeCredentials, Coin>): Promise<void> {
        // Clear existing
        await this.db`DELETE FROM stake`;
        // Insert new
        for (const [cred, amount] of stake) {
            await this
                .db`INSERT INTO stake (stake_credential, amount) VALUES (${cred.toCbor()}, ${amount})`;
        }
    }

    // Methods for delegations
    async getDelegations(): Promise<Map<StakeCredentials, PoolKeyHash>> {
        const result = await this.db`
            SELECT d.stake_credential, d.pool_key_hash
            FROM delegations d
        `;
        const delegations = new Map<StakeCredentials, PoolKeyHash>();
        for (const row of result) {
            const cred = StakeCredentials.fromCbor(row.stake_credential);
            const pool = PoolKeyHash.fromCbor(row.pool_key_hash);
            delegations.set(cred, pool);
        }
        return delegations;
    }

    async setDelegations(
        delegations: Map<StakeCredentials, PoolKeyHash>,
    ): Promise<void> {
        // Clear existing
        await this.db`DELETE FROM delegations`;
        // Insert new
        for (const [cred, pool] of delegations) {
            await this
                .db`INSERT INTO delegations (stake_credential, pool_key_hash) VALUES (${cred.toCbor()}, ${pool.toCbor()})`;
        }
    }

    // Method to get lastEpochModified
    async getLastEpochModified(): Promise<bigint> {
        const result = await this
            .db`SELECT last_epoch_modified FROM new_epoch_state`;
        return result.length > 0
            ? BigInt(result[0].last_epoch_modified as number)
            : 0n;
    }

    async setLastEpochModified(epoch: bigint): Promise<void> {
        await this
            .db`UPDATE new_epoch_state SET last_epoch_modified = ${epoch}`;
    }

    // Method to get pool distribution
    async getPoolDistr(): Promise<RawPoolDistr> {
        const result = await this.db`
            SELECT pd.data
            FROM pool_distr pd
            JOIN new_epoch_state nes ON pd.id = nes.pool_distr_id
        `;
        if (result.length === 0 || !result[0].data) {
            return new RawPoolDistr([], 0n);
        }
        const bytes = result[0].data;
        const cbor = Cbor.parse(bytes);
        return RawPoolDistr.fromCborObj(cbor);
    }

    static async init(
        dbPath: string,
        startEpoch: bigint = 0n,
        slotsPerKESPeriod: bigint = 1n,
        maxKESEvolutions: bigint = 1n,
    ): Promise<SQLNewEpochState> {
        const state = new SQLNewEpochState(dbPath);

        await state.init();
        // Insert initial data
        await state.db`INSERT OR IGNORE INTO new_epoch_state (epoch, last_epoch_modified, slots_per_kes_period, max_kes_evolutions) VALUES (${startEpoch}, 0, ${slotsPerKESPeriod}, ${maxKESEvolutions})`;
        await state.db`INSERT OR IGNORE INTO chain_account_state (id, treasury, reserves) VALUES (1, 0, 0)`;
        await state.db`INSERT OR IGNORE INTO ledger_state (id, utxo) VALUES (1, ${
            Cbor.encode(new CborArray([]))
        })`;
        await state.db`INSERT OR IGNORE INTO snapshots (id, stake_id, delegations_id, pparams_id) VALUES (1, NULL, NULL, NULL)`;
        await state.db`INSERT OR IGNORE INTO epoch_state (id, chain_account_state_id, ledger_state_id, snapshots_id) VALUES (1, 1, 1, 1)`;
        await state.db`UPDATE new_epoch_state SET epoch_state_id = 1 WHERE epoch = ${startEpoch}`;

        return state;
    }

    static async initFromSnapshot(
        dbPath: string,
        snapshotData: Uint8Array,
    ): Promise<SQLNewEpochState> {
        // Parse snapshotData as CBOR NES
        const cbor = Cbor.parse(snapshotData);
        // TODO: Implement full NES parsing and SQL population
        // For now, assume it's the NES CBOR and use fromCborObj
        return SQLNewEpochState.fromCborObj(dbPath, cbor);
    }

    static async fromCborObj(
        dbPath: string,
        cborObj: CborObj,
    ): Promise<SQLNewEpochState> {
        const state = new SQLNewEpochState(dbPath);
        await state.db`PRAGMA journal_mode = DELETE`;
        await state.db`PRAGMA synchronous = FULL`;
        await state.init();

        let lastEpochModified: CborObj;
        let epochState: CborObj;
        let poolDistr: CborObj | undefined;
        let snapshots: CborObj | undefined;
        let nonMyopic: CborObj | undefined;
        let pparams: CborObj | undefined;

        if (cborObj instanceof CborArray && cborObj.array.length === 7) {
            // Haskell NES format: [lastEpochModified, prevBlocks, currBlocks, epochState, rewardsUpdate, poolDistr, stashedAVVMAddrs]
            [lastEpochModified, , , epochState, , poolDistr] = cborObj.array;
        } else if (cborObj instanceof CborArray && cborObj.array.length === 2) {
            // Mithril snapshot format: [epoch, nes] where nes is [epochState, poolDistr, snapshots?, nonMyopic?, pparams?]
            const [epoch, nes] = cborObj.array;
            if (nes instanceof CborArray && nes.array.length >= 2) {
                epochState = nes.array[0];
                poolDistr = nes.array[1];
                if (nes.array.length >= 3) snapshots = nes.array[2];
                if (nes.array.length >= 4) nonMyopic = nes.array[3];
                if (nes.array.length >= 5) pparams = nes.array[4];
                // Override lastEpochModified with the snapshot epoch
                lastEpochModified = epoch;
            } else {
                throw new Error("Invalid Mithril snapshot: expected at least epochState and poolDistr");
            }
        } else {
            throw new Error(
                "Invalid CBOR - expected 7 elements for NES or 2 for Mithril snapshot",
            );
        }

        // Insert initial rows
        const epoch = BigInt((lastEpochModified as CborUInt).num);
        await state.db`INSERT INTO new_epoch_state (epoch, last_epoch_modified, slots_per_kes_period, max_kes_evolutions) VALUES (${epoch}, 0, 1, 1)`;
        await state.db`INSERT INTO chain_account_state (id, treasury, reserves) VALUES (1, 0, 0)`;
        await state.db`INSERT INTO ledger_state (id, utxo, cert_state) VALUES (1, ${Cbor.encode(new CborArray([]))}, NULL)`;
        await state.db`INSERT INTO snapshots (id, stake_id, delegations_id, pparams_id) VALUES (1, NULL, NULL, NULL)`;
        await state.db`INSERT INTO epoch_state (id, chain_account_state_id, ledger_state_id, snapshots_id, non_myopic_id) VALUES (1, 1, 1, 1, NULL)`;
        await state.db`UPDATE new_epoch_state SET epoch_state_id = 1 WHERE epoch = ${epoch}`;
        await state.db`INSERT INTO pool_distr (id, data) VALUES (1, NULL)`;
        await state.db`UPDATE new_epoch_state SET pool_distr_id = 1 WHERE epoch = ${epoch}`;

        // Parse epochState: [chainAccountState, ledgerState, snapshots?, nonMyopic?, pparams?]
        if (!(epochState instanceof CborArray) || epochState.array.length < 2) {
            throw new Error(
                "Invalid epochState CBOR - expected at least 2 elements",
            );
        }
        const chainAccountState = epochState.array[0];
        let ledgerState = epochState.array[1];
        if (ledgerState instanceof CborBytes) {
            ledgerState = Cbor.parse(ledgerState.bytes);
        }
        if (!snapshots) snapshots = epochState.array.length > 2 ? epochState.array[2] : undefined;
        if (!nonMyopic) nonMyopic = epochState.array.length > 3 ? epochState.array[3] : undefined;
        if (!pparams) pparams = epochState.array.length > 4 ? epochState.array[4] : undefined;

        // Extract treasury and reserves
        if (
            chainAccountState instanceof CborArray &&
            chainAccountState.array.length >= 2
        ) {
            const treasury = chainAccountState.array[0] as CborUInt;
            const reserves = chainAccountState.array[1] as CborUInt;
            await state.setTreasury(treasury.num);
            // Note: reserves not stored in current schema, could be added later
        }

        // Extract UTxO
        if (ledgerState instanceof CborArray && ledgerState.array.length >= 1) {
            const utxoCbor = ledgerState.array[0];
            if (utxoCbor instanceof CborArray) {
                const utxos = utxoCbor.array.map((obj) =>
                    ConwayUTxO.fromCborObj(obj)
                );
                await state.setUTxO(utxos);
            }
        }

        // Extract snapshots: [stakeMark, stakeSet, stakeGo?, fee?]
        if (snapshots instanceof CborArray && snapshots.array.length >= 2) {
            const stakeMark = snapshots.array[0];
            const stakeSet = snapshots.array[1];
            const stakeGo = snapshots.array.length > 2 ? snapshots.array[2] : undefined;

            // Use stakeSet as the current stake snapshot (most recent)
            if (stakeSet instanceof CborMap) {
                for (const { k, v } of stakeSet.map) {
                    if (k instanceof CborUInt) {
                        if (k.num === 0n) { // stake
                            if (v instanceof CborArray) {
                                const stakeMap = new Map<StakeCredentials, Coin>();
                                for (const entry of v.array) {
                                    if (entry instanceof CborArray && entry.array.length === 2) {
                                        const hashCbor = entry.array[0];
                                        const amountCbor = entry.array[1];
                                        if (hashCbor instanceof CborBytes && hashCbor.bytes.length === 28) {
                                            const hash = Hash28.fromCborObj(hashCbor);
                                            const cred = StakeCredentials.keyHash(hash);
                                            const amount = decodeCoin(amountCbor);
                                            stakeMap.set(cred, amount);
                                        }
                                    }
                                }
                                await state.setStake(stakeMap);
                            }
                        } else if (k.num === 5n) { // delegations
                            if (v instanceof CborMap) {
                                for (const { k: kk, v: vv } of v.map) {
                                    await state.db`INSERT INTO delegations (stake_credential, pool_key_hash) VALUES (${Cbor.encode(kk)}, ${Cbor.encode(vv)})`;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Extract pparams
        if (pparams) {
            const pparamsBytes = Cbor.encode(pparams);
            await state.db`INSERT OR REPLACE INTO pparams (id, params) VALUES (1, ${pparamsBytes})`;
            await state.db`UPDATE snapshots SET pparams_id = 1 WHERE id = 1`;
        }

        // Extract pool distribution
        if (poolDistr instanceof CborArray && poolDistr.array.length >= 2) {
            try {
                const rawPoolDistr = RawPoolDistr.fromCborObj(poolDistr);
                // Store pool distribution as CBOR blob (encode the original CBOR)
                const poolDistrBytes = Cbor.encode(poolDistr);
                await state.db`UPDATE pool_distr SET data = ${poolDistrBytes} WHERE id = 1`;
                logger.debug(
                    `Loaded pool distribution with ${rawPoolDistr.unPoolDistr.length} pools`,
                );
            } catch (e) {
                // Failed to parse pool distribution, skipping
            }
        }

        // Set last epoch modified
        if (lastEpochModified instanceof CborUInt) {
            await state.setLastEpochModified(BigInt(lastEpochModified.num));
        }

        return state;
    }
}
