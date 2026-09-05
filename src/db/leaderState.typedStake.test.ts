import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address, Credential, StakeCredentials } from "@harmoniclabs/cardano-ledger-ts";
import { initSql, sql } from "../sql";
import { ensureInitialized, ensureTypedStakeKeys, stakeKeyOfAddress } from "../db";
import { recordPoolRegistration, takeStakeSnapshot } from "./leaderState";
import { bech32HeaderByte, headerStakeIsScript, typedCredHex } from "./stakeCred";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-typed-"));
const HASH = "0c6aa3ecdd47e1ba5375db416b7fd9a86ace4f768d998180e6463809";
const PAY = "11".repeat(28), POOL = "ab".repeat(28), VRF = "01".repeat(32);
const keyAddr = Address.testnet(Credential.keyHash(PAY), StakeCredentials.keyHash(HASH)).toString();
const scriptAddr = Address.testnet(Credential.keyHash(PAY), StakeCredentials.script(HASH)).toString();

beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function utxo(ref: string, address: string, lovelace: number, stakeKey: string | null) {
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key)
        VALUES (${ref}, ${JSON.stringify({ address, amount: String(lovelace) })}, ${ref.split(":")[0]}, ${address}, ${lovelace}, NULL, ${stakeKey})`;
}

describe("stake credentials are (type, hash)", () => {
    test("a script-stake address keys as 01 + hash; a key-stake address as the bare hash", () => {
        expect(stakeKeyOfAddress(keyAddr)).toBe(HASH);
        expect(stakeKeyOfAddress(scriptAddr)).toBe(`01${HASH}`);
        expect(headerStakeIsScript(bech32HeaderByte(scriptAddr)!)).toBe(true);
        expect(headerStakeIsScript(bech32HeaderByte(keyAddr)!)).toBe(false);
        expect(typedCredHex(1, HASH)).toBe(`01${HASH}`);
    });

    test("the snapshot attributes script-stake outputs to the script credential only (preprod pool 5cb14d2c…, +2.2e9)", async () => {
        await utxo("aa".repeat(32) + ":0", keyAddr, 97_825_699, stakeKeyOfAddress(keyAddr));
        await utxo("bb".repeat(32) + ":0", scriptAddr, 2_197_692_556, stakeKeyOfAddress(scriptAddr));
        await recordPoolRegistration(sql, POOL, VRF, 100, { pledge: "0", cost: "0", marginNum: "0", marginDen: "1", rewardAccount: "cd".repeat(28), owners: [] });
        const cred = Buffer.from(HASH, "hex");
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${cred}, 0, 0)`;
        await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${cred}, 0, ${Buffer.from(POOL, "hex")})`;
        const snap = await takeStakeSnapshot(sql, 10);
        expect(snap.total).toBe(97_825_699n);
        const rows = (await sql`SELECT stake_key, stake FROM epoch_stake_cred WHERE taken_at = 10`.values()) as unknown[][];
        expect(rows).toEqual([[HASH, 97_825_699]]);
    });

    test("a legacy (untyped) delegation still matches both forms; the migration retags legacy script outputs", async () => {
        await sql`DELETE FROM delegations`;
        await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${Buffer.from(HASH, "hex")}, NULL, ${Buffer.from(POOL, "hex")})`;
        const snap = await takeStakeSnapshot(sql, 11);
        expect(snap.total).toBe(97_825_699n + 2_197_692_556n);
        // a row written before typing: bare hash on a script-stake address
        await utxo("cc".repeat(32) + ":0", scriptAddr, 5, HASH);
        await sql`DELETE FROM schema_migrations WHERE name = 'utxo_stake_key_typed'`;
        await ensureTypedStakeKeys();
        const k = (await sql`SELECT stake_key FROM utxo WHERE utxo_ref = ${"cc".repeat(32) + ":0"}`.values()) as unknown[][];
        expect(String(k[0]![0])).toBe(`01${HASH}`);
    });
});
