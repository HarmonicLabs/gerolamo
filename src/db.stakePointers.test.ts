import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { initSql, sql } from "./sql";
import { dropPointerStakeForConway, ensureInitialized, pointerOfAddress, pointerOfAddressString, resolveStakePointer, stakeKeyOfAddress } from "./db";
import { outputAddressString } from "./utils/byronAddressString";
import { typedCredHexOf } from "./db/stakeCred";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-ptr-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const load = async (slot: number) => MultiEraBlock.fromCbor(Buffer.from((await Bun.file(new URL(`./consensus/__fixtures__/preview-block-${slot}.hex`, import.meta.url)).text()).trim(), "hex")) as any;

// Preview: tx 352b780d… (slot 10703285) pays 35.55·10⁹ to a pointer address naming the
// registration at (slot 2940289, tx 1, cert 0), which registered credential 0c90492b….
describe("pointer addresses", () => {
    test("the pointer is read from the raw bytes, the full address is kept, and it resolves to the registered credential", async () => {
        const m = await load(10703285);
        const out = m.block.transactionBodies.find((t: any) => String(t.hash).startsWith("352b780d"))!.outputs[0];
        const ptr = pointerOfAddress(out.address);
        expect(ptr).toEqual({ slot: 2940289, txIx: 1, certIx: 0 });
        const full = outputAddressString(out.address);
        expect(full.startsWith("addr_test1g")).toBe(true);
        expect(pointerOfAddressString(full)).toEqual(ptr);
        expect(stakeKeyOfAddress(full)).toBeNull(); // resolution needs the registration index
        const reg = await load(2940289);
        const cert = reg.block.transactionBodies[1].certs[0];
        expect(Number(cert.certType)).toBe(0);
        const key = typedCredHexOf(cert.stakeCredential)!;
        expect(key.startsWith("0c90492bbe7eb3")).toBe(true);
        expect(await resolveStakePointer(sql, ptr!)).toBeNull();
        await sql`INSERT INTO stake_pointers (slot, tx_ix, cert_ix, stake_key) VALUES (${ptr!.slot}, ${ptr!.txIx}, ${ptr!.certIx}, ${key})`;
        expect(await resolveStakePointer(sql, ptr!)).toBe(key);
    });
});

describe("Conway translation", () => {
    test("pointer-address outputs stop counting for their credential; balances follow (bug 93)", async () => {
        const m = await load(10703285);
        const out = m.block.transactionBodies.find((t: any) => String(t.hash).startsWith("352b780d"))!.outputs[0];
        const full = outputAddressString(out.address);
        const key = "0c90492bbe7eb33f38173255e547dc3194abcec5cd29cdf504bb4f03";
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, stake_key) VALUES ('ptr:0', '{}', 'ptr', ${full}, 35553328331, ${key})`;
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, stake_key) VALUES ('base:0', '{}', 'base', 'addr_test1qbase', 1000000, ${key})`;
        const bal = async () => Number((await sql`SELECT lovelace FROM stake_balance WHERE stake_key = ${key}`.values())[0]?.[0] ?? 0);
        expect(await bal()).toBe(35553328331 + 1000000);
        expect(await dropPointerStakeForConway(sql)).toEqual({ outputs: 1, lovelace: 35553328331n });
        expect(await bal()).toBe(1000000);
        expect((await sql`SELECT stake_key FROM utxo WHERE utxo_ref = 'ptr:0'`.values())[0]![0]).toBeNull();
        expect(await dropPointerStakeForConway(sql)).toEqual({ outputs: 0, lovelace: 0n }); // idempotent
        await sql`DELETE FROM utxo WHERE utxo_ref = 'ptr:0'`; // a later spend of the dropped output leaves the balance alone
        expect(await bal()).toBe(1000000);
    });
});
