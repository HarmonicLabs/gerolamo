import { SQL } from "bun";
import { Cbor, CborMap } from "@harmoniclabs/cbor";
import {
    RawLedgerState,
    RawUTxOState,
} from "../rawNES/epoch_state/ledger_state";
import { RawPoolDistr } from "../rawNES/pool_distr";
import { TxOut, TxOutRef, UTxO } from "@harmoniclabs/cardano-ledger-ts";
import * as path from "node:path";
import { existsSync, readdirSync, statSync } from "fs";

export class SQLNewEpochState {
    private db: SQL;

    constructor(db: SQL | string) {
        if (typeof db === "string") {
            this.db = new SQL(`file:${db}`);
        } else {
            this.db = db;
        }
    }

    async init(): Promise<void> {
        await this.db`PRAGMA journal_mode = DELETE`;
        await this.db`PRAGMA synchronous = FULL`;

        // Create tables for ledger state
        await this.db`
            CREATE TABLE IF NOT EXISTS utxo (
                utxo_ref BLOB,
                tx_out BLOB,
                PRIMARY KEY (utxo_ref)
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS cert_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS ledger_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                utxo_deposited TEXT,
                utxo_fees TEXT,
                utxo_gov_state BLOB,
                utxo_instant_stake BLOB,
                utxo_donation TEXT,
                cert_state_id INTEGER,
                FOREIGN KEY (cert_state_id) REFERENCES cert_state(id)
            );
        `;
    }

    static async initFromSnapshot(
        dbPath: string,
        snapshotData: Uint8Array,
    ): Promise<SQLNewEpochState> {
        console.log("Parsing CBOR");
        const cbor = Cbor.parse(snapshotData);
        console.log("Parsed CBOR, creating RawLedgerState");
        const rawLedgerState = RawLedgerState.fromCborObj(cbor);
        console.log("Created RawLedgerState");
        const state = new SQLNewEpochState(dbPath);
        await state.init();
        await state.loadFromRawLedgerState(rawLedgerState);
        return state;
    }

    static async initFromChunk(
        snapshotRoot: string,
        dbPath: string,
    ): Promise<SQLNewEpochState> {
        const ledgerDir = path.join(snapshotRoot, "ledger");
        if (!existsSync(ledgerDir)) {
            throw new Error(`Ledger directory not found at ${ledgerDir}`);
        }

        // Find the latest slot directory in ledger
        const slotDirs = readdirSync(ledgerDir)
            .map((name) => ({ name, path: path.join(ledgerDir, name) }))
            .filter((item) =>
                statSync(item.path).isDirectory() && /^\d+$/.test(item.name)
            )
            .sort((a, b) => parseInt(b.name) - parseInt(a.name));

        if (slotDirs.length === 0) {
            throw new Error("No slot directories found in ledger");
        }

        const latestSlotDir = path.join(slotDirs[0].path, "tables");

        // Run mdb_dump and parse output
        const proc = Bun.spawn(["mdb_dump", latestSlotDir], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`mdb_dump failed: ${stderr}`);
        }

        // Parse the dump output
        const lines = output.split("\n");
        const utxos: UTxO[] = [];
        let inData = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === "HEADER=END") {
                inData = true;
                continue;
            }
            if (line === "DATA=END") {
                break;
            }
            if (inData && line && lines[i + 1]) {
                const keyHex = line;
                const valueHex = lines[i + 1].trim();
                if (keyHex === "7574786f" || keyHex === "5f64627374617465") { // skip 'utxo' and '_dbstate'
                    i++; // skip value
                    continue;
                }
                try {
                    // Decode key and value hex to bytes
                    const keyBytes = new Uint8Array(keyHex.length / 2);
                    for (let j = 0; j < keyHex.length; j += 2) {
                        keyBytes[j / 2] = parseInt(keyHex.substr(j, 2), 16);
                    }
                    const valueBytes = new Uint8Array(valueHex.length / 2);
                    for (let j = 0; j < valueHex.length; j += 2) {
                        valueBytes[j / 2] = parseInt(valueHex.substr(j, 2), 16);
                    }

                    const utxoRef = TxOutRef.fromCborObj(Cbor.parse(keyBytes));
                    const txOut = TxOut.fromCborObj(Cbor.parse(valueBytes));
                    utxos.push(new UTxO({ utxoRef, resolved: txOut }));
                } catch (e) {
                    console.log("Failed to parse entry", keyHex, e);
                }
                i++; // skip value line
            }
        }

        const rawUTxOState = new RawUTxOState(
            utxos,
            0n,
            0n,
            undefined,
            undefined,
            0n,
        );

        // Create dummy certState and other fields
        const dummyCertState = new CborMap([]); // Empty map for now
        const rawLedgerState = new RawLedgerState(rawUTxOState, dummyCertState);

        const state = new SQLNewEpochState(dbPath);
        await state.init();
        await state.loadFromRawLedgerState(rawLedgerState);
        return state;
    }

    async loadFromRawLedgerState(rawLS: RawLedgerState): Promise<void> {
        // Insert cert_state
        const certStateId = await this.insertCertState(rawLS.certState);

        // Insert UTxO
        try {
            await this.insertUTxO(rawLS.UTxOState.UTxO);
        } catch (e) {
            console.log("Skipping UTxO insertion:", e);
        }

        // Insert ledger_state
        await this.insertLedgerState(rawLS, certStateId);
    }

    private async insertCertState(certState: any): Promise<number> {
        const certCbor = Cbor.encode(certState);
        const result = await this.db`
            INSERT INTO cert_state (data) VALUES (${certCbor})
            RETURNING id
        `;
        return result[0].id as number;
    }

    private async insertUTxO(utxos: UTxO[]): Promise<void> {
        for (const utxo of utxos) {
            const utxoRefCbor = utxo.utxoRef.toCborObj();
            const txOutCbor = utxo.resolved.toCborObj();
            await this.db`
                INSERT OR REPLACE INTO utxo (utxo_ref, tx_out) VALUES (${
                Cbor.encode(utxoRefCbor)
            }, ${Cbor.encode(txOutCbor)})
            `;
        }
    }

    private async insertLedgerState(
        rawLS: RawLedgerState,
        certStateId: number,
    ): Promise<void> {
        const utxoState = rawLS.UTxOState;
        await this.db`
            INSERT INTO ledger_state (utxo_deposited, utxo_fees, utxo_gov_state, utxo_instant_stake, utxo_donation, cert_state_id)
            VALUES (${utxoState.deposited.toString()}, ${utxoState.fees.toString()}, ${
            utxoState.govState ? Cbor.encode(utxoState.govState as any) : null
        }, ${
            utxoState.instantStake
                ? Cbor.encode(utxoState.instantStake as any)
                : null
        }, ${utxoState.donation.toString()}, ${certStateId})
        `;
    }

    async getUTxO(): Promise<UTxO[]> {
        const result = await this.db`
            SELECT utxo_ref, tx_out FROM utxo
        `;
        return result.map((row) => {
            const utxoRefCbor = Cbor.parse(row.utxo_ref);
            const txOutCbor = Cbor.parse(row.tx_out);
            return new UTxO({
                utxoRef: TxOutRef.fromCborObj(utxoRefCbor),
                resolved: TxOut.fromCborObj(txOutCbor),
            });
        });
    }

    async getPoolDistr(): Promise<RawPoolDistr> {
        // Since pool distr is not loaded, return empty
        return new RawPoolDistr([], 0n);
    }

    async getTreasury(): Promise<bigint> {
        const result = await this.db`
            SELECT cas.treasury
            FROM chain_account_state cas
            JOIN epoch_state es ON cas.id = es.chain_account_state_id
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
        `;
        return result.length > 0 ? BigInt(result[0].treasury as string) : 0n;
    }

    async setTreasury(treasury: bigint): Promise<void> {
        await this.db`
            UPDATE chain_account_state
            SET treasury = ${treasury.toString()}
            FROM epoch_state es
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
            WHERE chain_account_state.id = es.chain_account_state_id
        `;
    }

    async getReserves(): Promise<bigint> {
        const result = await this.db`
            SELECT cas.reserves
            FROM chain_account_state cas
            JOIN epoch_state es ON cas.id = es.chain_account_state_id
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
        `;
        return result.length > 0 ? BigInt(result[0].reserves as string) : 0n;
    }

    async setReserves(reserves: bigint): Promise<void> {
        await this.db`
            UPDATE chain_account_state
            SET reserves = ${reserves.toString()}
            FROM epoch_state es
            JOIN new_epoch_state nes ON es.id = nes.epoch_state_id
            WHERE chain_account_state.id = es.chain_account_state_id
        `;
    }

    async close(): Promise<void> {
        this.db.close();
    }
}
