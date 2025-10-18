import { Cbor, CborObj } from "@harmoniclabs/cbor";
import { INewEpochState, RawNewEpochState } from "../../rawNES";
import SQL from "bun:sqlite";

// Minimal SQLite-backed NewEpochState implementation
export class NewEpochState implements INewEpochState {
    private db: SQL;
    private epochNo: number;
    private _nes?: any; // Cached parsed NES object

    constructor(db: SQL, epochNo: number) {
        this.db = db;
        this.epochNo = epochNo;
    }

    static async initDB(db: SQL): Promise<void> {
        // Schema version
        await db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY CHECK (version = 1)
        )`);

        // NES storage
        await db.exec(`CREATE TABLE IF NOT EXISTS nes_storage (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            nes_cbor BLOB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Basic metadata
        await db.exec(`CREATE TABLE IF NOT EXISTS nes_metadata (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE REFERENCES nes_storage(epoch_no),
            last_epoch_modified INTEGER NOT NULL,
            total_stake BIGINT,
            treasury BIGINT,
            reserves BIGINT
        )`);

        // Indexes
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_nes_storage_epoch ON nes_storage(epoch_no)`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_nes_metadata_epoch ON nes_metadata(epoch_no)`);

        // Insert schema version
        await db.run(`INSERT OR IGNORE INTO schema_version (version) VALUES (?)`, [1]);
    }

    // Lazy load NES from database
    private loadNES(): any {
        if (!this._nes) {
            const row = this.db.prepare(
                "SELECT nes_cbor FROM nes_storage WHERE epoch_no = ?"
            ).get(this.epochNo) as { nes_cbor: Uint8Array } | undefined;

            if (!row) throw new Error(`NES not found for epoch ${this.epochNo}`);

            const cborObj = Cbor.parse(row.nes_cbor);
            this._nes = RawNewEpochState.fromCborObj(cborObj);
        }
        return this._nes;
    }

    // INewEpochState interface implementation
    get lastEpochModified(): any {
        return this._nes?.lastEpochModified;
    }

    set lastEpochModified(value: any) {
        if (this._nes) this._nes.lastEpochModified = value;
    }

    get prevBlocks(): any {
        return this._nes?.prevBlocks;
    }

    set prevBlocks(value: any) {
        if (this._nes) this._nes.prevBlocks = value;
    }

    get currBlocks(): any {
        return this._nes?.currBlocks;
    }

    set currBlocks(value: any) {
        if (this._nes) this._nes.currBlocks = value;
    }

    get epochState(): any {
        return this._nes?.epochState;
    }

    set epochState(value: any) {
        if (this._nes) this._nes.epochState = value;
    }

    get pulsingRewUpdate(): any {
        return this._nes?.pulsingRewUpdate;
    }

    set pulsingRewUpdate(value: any) {
        if (this._nes) this._nes.pulsingRewUpdate = value;
    }

    get poolDistr(): any {
        return this._nes?.poolDistr;
    }

    set poolDistr(value: any) {
        if (this._nes) this._nes.poolDistr = value;
    }

    get stashedAvvmAddresses(): any {
        return this._nes?.stashedAvvmAddresses;
    }

    set stashedAvvmAddresses(value: any) {
        if (this._nes) this._nes.stashedAvvmAddresses = value;
    }

    // CBOR round-trip compatibility
    static fromCborObj(db: SQL, cborObj: CborObj): NewEpochState {
        // Parse to get epoch number for storage
        const rawNES = RawNewEpochState.fromCborObj(cborObj);
        const epochNo = Number(rawNES.lastEpochModified);

        // Store in database
        const cborBytes = Cbor.encode(cborObj).asBytes;
        db.prepare(
            `INSERT OR REPLACE INTO nes_storage (epoch_no, nes_cbor) VALUES (?, ?)`
        ).run(epochNo, cborBytes);

        // Update metadata
        db.prepare(
            `INSERT OR REPLACE INTO nes_metadata
             (epoch_no, last_epoch_modified) VALUES (?, ?)`
        ).run(epochNo, epochNo);

        return new NewEpochState(db, epochNo);
    }

    toCborObj(): CborObj {
        const nes = this.loadNES();
        return nes.toCborObj();
    }

    // Factory methods
    static create(db: SQL, epochNo: number): NewEpochState {
        // Initialize empty NES for new epoch
        const emptyNES = RawNewEpochState.init(BigInt(epochNo));
        const cborBytes = Cbor.encode(emptyNES.toCborObj()).asBytes;

        db.prepare(
            `INSERT OR REPLACE INTO nes_storage (epoch_no, nes_cbor) VALUES (?, ?)`
        ).run(epochNo, cborBytes);

        db.prepare(
            `INSERT OR REPLACE INTO nes_metadata
             (epoch_no, last_epoch_modified) VALUES (?, ?)`
        ).run(epochNo, epochNo);

        return new NewEpochState(db, epochNo);
    }

    static load(db: SQL, epochNo: number): NewEpochState | null {
        const row = db.prepare(
            "SELECT epoch_no FROM nes_storage WHERE epoch_no = ?"
        ).get(epochNo) as { epoch_no: number } | undefined;

        return row ? new NewEpochState(db, epochNo) : null;
    }

    // Save current state to database
    save(): void {
        if (!this._nes) return;

        const cborBytes = Cbor.encode(this._nes.toCborObj()).asBytes;
        this.db.prepare(
            `UPDATE nes_storage SET nes_cbor = ?, updated_at = CURRENT_TIMESTAMP
             WHERE epoch_no = ?`
        ).run(cborBytes, this.epochNo);
    }
}

