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
    CborPositiveRational,
    CborSimple,
    CborUInt,
    isRawCborTag,
} from "@harmoniclabs/cbor";
import { logger } from "../../utils/logger";

// Import from rawNES
import { RawNewEpochState } from "../rawNES";
import { RawPoolDistr } from "../rawNES/pool_distr";
import { RawBlocksMade } from "../rawNES/blocks";
import { decodeCoin, encodeCoin } from "../rawNES/epoch_state/common";
import {
    RawLedgerState,
    RawUTxOState,
} from "../rawNES/epoch_state/ledger_state";
import { RawChainAccountState } from "../rawNES/epoch_state/chain_account_state";
import { RawNonMyopic } from "../rawNES/epoch_state/non_myopic";
import { isRationalOrUndefined } from "@harmoniclabs/buildooor/dist/utils/Rational";
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
                data BLOB
            );
        `;

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

    async loadFromRawNES(rawNES: RawNewEpochState): Promise<void> {
        const epoch = BigInt(rawNES.lastEpochModified);

        // Insert chain_account_state
        const casId = await this.insertChainAccountState(
            rawNES.epochState.chainAccountState,
        );

        // Insert ledger_state
        const lsId = await this.insertLedgerState(
            rawNES.epochState.ledgerState,
        );

        // Insert snapshots (stake, delegations, pparams from stakeSet)
        const snapsId = await this.insertSnapshots(rawNES.epochState.snapshots);

        // Insert non_myopic
        const nmId = await this.insertNonMyopic(rawNES.epochState.nonMyopic);

        // Insert epoch_state
        const esId = await this.insertEpochState(casId, lsId, snapsId, nmId);

        // Insert pulsing_rew_update
        const pruId = await this.insertPulsingRewUpdate(
            rawNES.pulsingRewUpdate,
        );

        // Insert pool_distr
        const pdId = await this.insertPoolDistr(rawNES.poolDistr);

        // Insert stashed_avvm_addresses
        const savId = await this.insertStashedAVVM(rawNES.stashedAvvmAddresses);

        // Insert blocks_made
        await this.insertBlocksMade(rawNES.prevBlocks, epoch, false);
        await this.insertBlocksMade(rawNES.currBlocks, epoch, true);

        // Insert new_epoch_state
        await this.insertNewEpochState(
            epoch,
            BigInt(rawNES.lastEpochModified),
            rawNES.slotsPerKESPeriod,
            rawNES.maxKESEvolutions,
            esId,
            pruId,
            pdId,
            savId,
        );
    }

    private async insertChainAccountState(cas: any): Promise<number> {
        const result = await this.db`
            INSERT INTO chain_account_state (treasury, reserves) VALUES (${
            Number(cas.casTreasury)
        }, ${Number(cas.casReserves)})
            RETURNING id
        `;

        return result[0].id as number;
    }

    private async insertLedgerState(ls: any): Promise<number> {
        const utxoCbor = Cbor.encode(RawUTxOState.toCborObj(ls.UTxOState));
        const certStateCbor = Cbor.encode(ls.certState);
        const result = await this.db`
            INSERT INTO ledger_state (utxo, cert_state) VALUES (${utxoCbor}, ${certStateCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertSnapshots(snaps: any): Promise<number> {
        // Use stakeSet for stake and delegations
        const stakeSet = snaps.stakeSet;
        await this.setStake(
            new Map(
                stakeSet.stake.map((
                    [cred, coin]: [any, bigint],
                ) => [cred, coin]),
            ),
        );
        await this.setDelegations(
            new Map(
                stakeSet.delegations.map((
                    [cred, pool]: [any, any],
                ) => [cred, pool]),
            ),
        );

        // Insert pparams
        const pparamsMap = new CborMap(
            stakeSet.poolParams.pparams.map(([pool, params]: [any, any]) => ({
                k: pool.toCborObj(),
                v: params.toCborObj(),
            })),
        );
        const pparamsCbor = Cbor.encode(pparamsMap);
        await this
            .db`INSERT OR REPLACE INTO pparams (id, params) VALUES (1, ${pparamsCbor})`;

        // Insert snapshots entry
        const result = await this.db`
            INSERT INTO snapshots (stake_id, delegations_id, pparams_id) VALUES (NULL, NULL, 1)
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertNonMyopic(nm: any): Promise<number> {
        // Store as BLOB
        const likMap = new CborMap(
            Array.from(nm.likelihoods.entries()).map(([pool, lik]) => ({
                k: pool.toCborObj(),
                v: new CborArray(
                    lik.value.map((n: number) => new CborSimple(n)),
                ),
            })),
        );
        const nmArray = new CborArray([likMap, encodeCoin(nm.rewardPot)]);
        const nmCbor = Cbor.encode(nmArray);
        const result = await this.db`
            INSERT INTO non_myopic (data) VALUES (${nmCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertEpochState(
        casId: number,
        lsId: number,
        snapsId: number,
        nmId: number,
    ): Promise<number> {
        const result = await this.db`
            INSERT INTO epoch_state (chain_account_state_id, ledger_state_id, snapshots_id, non_myopic_id) VALUES (${casId}, ${lsId}, ${snapsId}, ${nmId})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertPulsingRewUpdate(pru: any): Promise<number> {
        const pruCbor = Cbor.encode(pru.toCborObj ? pru.toCborObj() : pru);
        const result = await this.db`
            INSERT INTO pulsing_rew_update (data) VALUES (${pruCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertPoolDistr(pd: RawPoolDistr): Promise<number> {
        const unPoolDistrMap = new CborMap(
            pd.unPoolDistr.map(([pool, ips]) => ({
                k: pool.toCborObj(),
                v: new CborArray([
                    typeof ips.individualPoolStake === "number" ?
                        CborPositiveRational.fromNumber(ips.individualPoolStake) :
                        ips.individualPoolStake,
                    encodeCoin(ips.individualTotalPoolStake),
                    ips.individualPoolStakeVrf.toCborObj(),
                ]),
            })),
        );
        const pdArray = new CborArray([
            unPoolDistrMap,
            encodeCoin(pd.totalActiveStake),
        ]);
        const pdCbor = Cbor.encode(pdArray);
        const result = await this.db`
            INSERT INTO pool_distr (data) VALUES (${pdCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertStashedAVVM(sav: any): Promise<number> {
        const savCbor = Cbor.encode(sav.toCborObj ? sav.toCborObj() : sav);
        const result = await this.db`
            INSERT INTO stashed_avvm_addresses (data) VALUES (${savCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertBlocksMade(
        bm: RawBlocksMade,
        epoch: bigint,
        isPrev: boolean,
    ): Promise<void> {
        for (const [pool, blocks] of bm.value) {
            await this.db`
                INSERT INTO blocks_made (epoch, is_prev, pool_hash, blocks) VALUES (${epoch}, ${isPrev}, ${pool.toCbor()}, ${blocks})
            `;
        }
    }

    private async insertNewEpochState(
        epoch: bigint,
        lastEpochModified: bigint,
        slotsPerKES: bigint,
        maxKES: bigint,
        esId: number,
        pruId: number,
        pdId: number,
        savId: number,
    ): Promise<void> {
        await this.db`
            INSERT INTO new_epoch_state (epoch, last_epoch_modified, slots_per_kes_period, max_kes_evolutions, epoch_state_id, pulsing_rew_update_id, pool_distr_id, stashed_avvm_addresses_id) 
            VALUES (${epoch}, ${lastEpochModified}, ${slotsPerKES}, ${maxKES}, ${esId}, ${pruId}, ${pdId}, ${savId})
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
        await state
            .db`INSERT OR IGNORE INTO new_epoch_state (epoch, last_epoch_modified, slots_per_kes_period, max_kes_evolutions) VALUES (${startEpoch}, 0, ${slotsPerKESPeriod}, ${maxKESEvolutions})`;
        await state
            .db`INSERT OR IGNORE INTO chain_account_state (id, treasury, reserves) VALUES (1, 0, 0)`;
        await state
            .db`INSERT OR IGNORE INTO ledger_state (id, utxo) VALUES (1, ${
            Cbor.encode(new CborArray([]))
        })`;
        await state
            .db`INSERT OR IGNORE INTO snapshots (id, stake_id, delegations_id, pparams_id) VALUES (1, NULL, NULL, NULL)`;
        await state
            .db`INSERT OR IGNORE INTO epoch_state (id, chain_account_state_id, ledger_state_id, snapshots_id) VALUES (1, 1, 1, 1)`;
        await state
            .db`UPDATE new_epoch_state SET epoch_state_id = 1 WHERE epoch = ${startEpoch}`;

        return state;
    }

    static async initFromSnapshot(
        dbPath: string,
        snapshotData: Uint8Array,
    ): Promise<SQLNewEpochState> {
        const cbor = Cbor.parse(snapshotData);
        const rawNES = RawNewEpochState.fromCborObj(cbor);
        const state = new SQLNewEpochState(dbPath);
        await state.init();
        await state.loadFromRawNES(rawNES);
        return state;
    }
}
