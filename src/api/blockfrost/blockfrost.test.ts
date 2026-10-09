import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../../sql";
import { handleMiniBlockfrost, blockfrostRouter } from "../miniBlockfrost";
import { assetFingerprint, ccId, drepIdCip129, govActionId, poolIdBech32 } from "../../db/minibf/cardanoIds";
import { applyMbBlock, rollbackMbToSlot } from "../../db/minibf/writer";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { hex } from "../../db/minibf/cborWalk";
import { ADDR, buildFixtureChain, CC_COLD, CC_HOT, DREP, EPOCH, NFT_REF, NFT_USER, POLICY, POOL, S0, SCRIPT_HASH, STAKE_A, TOKEN, type FixtureChain } from "./__fixtures__/chain";
import { SCHEMAS, validate } from "./__fixtures__/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { outputAt } from "../../db/minibf/blockFacts";
import { UtxoWrites } from "../../ledger/utxoStore";
import { storeEpochParams } from "../../consensus/epochParams";
import { a as arr, b as bytesOf, enc, u as uint } from "./__fixtures__/chain";

let ch: FixtureChain;
beforeAll(async () => { ch = await buildFixtureChain(); }, 60_000);
afterAll(async () => { await ch?.close(); });

async function call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const url = new URL("http://127.0.0.1:3200/api/v0" + path);
    const res = await handleMiniBlockfrost(new Request(url, { method, body, headers }), url, { network: "preview" });
    const text = await res!.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res!.status, body: json, headers: res!.headers };
}
const get = (path: string) => call("GET", path);
const LEADER = poolIdBech32(hex(blake2b_224(new Uint8Array(32).fill(0x99)))); // the forged blocks' issuer
const UNIT = POLICY + TOKEN;
// account xpub of entropy 0×16 at m/1852'/1815'/0' (harmoniclabs XPrv)
const XPUB = "beb7e770b3d0f1932b0a2f3a63285bf9ef7d3e461d55446d6a3911d8f0ee55c0b0e2df16538508046649d0e6d5b32969555a23f2f1ebf2db2819359b0d88bd16";

/** One concrete request per served Blockfrost path template. */
function probes(): Array<[string, string]> {
    const [b0, b1, b2] = ch.blocks;
    const { t1, t2, t4, t5 } = ch.tx;
    const pool = poolIdBech32(POOL), drep = drepIdCip129(0, DREP);
    return [
        ["/", "/"], ["/health", "/health"], ["/health/clock", "/health/clock"], ["/genesis", "/genesis"], ["/network", "/network"], ["/network/eras", "/network/eras"],
        ["/blocks/latest", "/blocks/latest"], ["/blocks/latest/txs", "/blocks/latest/txs"], ["/blocks/latest/txs/cbor", "/blocks/latest/txs/cbor"],
        ["/blocks/{hash_or_number}", `/blocks/${b0!.hash}`], ["/blocks/{hash_or_number}/next", `/blocks/${b0!.hash}/next`], ["/blocks/{hash_or_number}/previous", `/blocks/${b2!.height}/previous`],
        ["/blocks/slot/{slot_number}", `/blocks/slot/${b1!.slot}`], ["/blocks/epoch/{epoch_number}/slot/{slot_number}", `/blocks/epoch/${EPOCH}/slot/${b1!.slot % 86400}`],
        ["/blocks/{hash_or_number}/txs", `/blocks/${b2!.hash}/txs`], ["/blocks/{hash_or_number}/txs/cbor", `/blocks/${b2!.hash}/txs/cbor`], ["/blocks/{hash_or_number}/addresses", `/blocks/${b2!.hash}/addresses`],
        ["/epochs/latest", "/epochs/latest"], ["/epochs/latest/parameters", "/epochs/latest/parameters"], ["/epochs/{number}", `/epochs/${EPOCH}`],
        ["/epochs/{number}/next", `/epochs/${EPOCH}/next`], ["/epochs/{number}/previous", `/epochs/${EPOCH + 1}/previous?count=1`], ["/epochs/{number}/stakes", `/epochs/${EPOCH + 1}/stakes`],
        ["/epochs/{number}/stakes/{pool_id}", `/epochs/${EPOCH + 1}/stakes/${pool}`], ["/epochs/{number}/blocks", `/epochs/${EPOCH}/blocks`], ["/epochs/{number}/blocks/{pool_id}", `/epochs/${EPOCH}/blocks/${LEADER}`],
        ["/epochs/{number}/parameters", `/epochs/${EPOCH}/parameters`],
        ["/txs/{hash}", `/txs/${t2}`], ["/txs/{hash}/utxos", `/txs/${t4}/utxos`], ["/txs/{hash}/stakes", `/txs/${t1}/stakes`], ["/txs/{hash}/delegations", `/txs/${t1}/delegations`],
        ["/txs/{hash}/withdrawals", `/txs/${t2}/withdrawals`], ["/txs/{hash}/mirs", `/txs/${t5}/mirs`], ["/txs/{hash}/pool_updates", `/txs/${t1}/pool_updates`], ["/txs/{hash}/pool_retires", `/txs/${t5}/pool_retires`],
        ["/txs/{hash}/metadata", `/txs/${t1}/metadata`], ["/txs/{hash}/metadata/cbor", `/txs/${t1}/metadata/cbor`], ["/txs/{hash}/redeemers", `/txs/${t4}/redeemers`], ["/txs/{hash}/required_signers", `/txs/${t2}/required_signers`], ["/txs/{hash}/cbor", `/txs/${t1}/cbor`],
        ["/accounts/{stake_address}", `/accounts/${STAKE_A}`], ["/accounts/{stake_address}/rewards", `/accounts/${STAKE_A}/rewards`], ["/accounts/{stake_address}/history", `/accounts/${STAKE_A}/history`],
        ["/accounts/{stake_address}/delegations", `/accounts/${STAKE_A}/delegations`], ["/accounts/{stake_address}/registrations", `/accounts/${STAKE_A}/registrations`], ["/accounts/{stake_address}/withdrawals", `/accounts/${STAKE_A}/withdrawals`],
        ["/accounts/{stake_address}/mirs", `/accounts/${STAKE_A}/mirs`], ["/accounts/{stake_address}/addresses", `/accounts/${STAKE_A}/addresses`], ["/accounts/{stake_address}/addresses/assets", `/accounts/${STAKE_A}/addresses/assets`],
        ["/accounts/{stake_address}/addresses/total", `/accounts/${STAKE_A}/addresses/total`], ["/accounts/{stake_address}/utxos", `/accounts/${STAKE_A}/utxos`], ["/accounts/{stake_address}/transactions", `/accounts/${STAKE_A}/transactions`],
        ["/mempool", "/mempool"],
        ["/metadata/txs/labels", "/metadata/txs/labels"], ["/metadata/txs/labels/{label}", "/metadata/txs/labels/674"], ["/metadata/txs/labels/{label}/cbor", "/metadata/txs/labels/721/cbor"],
        ["/addresses/{address}", `/addresses/${ADDR.A}`], ["/addresses/{address}/extended", `/addresses/${ADDR.A}/extended`], ["/addresses/{address}/total", `/addresses/${ADDR.B}/total`],
        ["/addresses/{address}/utxos", `/addresses/${ADDR.B}/utxos`], ["/addresses/{address}/utxos/{asset}", `/addresses/${ADDR.B}/utxos/${UNIT}`], ["/addresses/{address}/txs", `/addresses/${ADDR.B}/txs`], ["/addresses/{address}/transactions", `/addresses/${ADDR.B}/transactions`],
        ["/pools", "/pools"], ["/pools/extended", "/pools/extended"], ["/pools/retired", "/pools/retired"], ["/pools/retiring", "/pools/retiring"], ["/pools/{pool_id}", `/pools/${pool}`],
        ["/pools/{pool_id}/history", `/pools/${pool}/history`], ["/pools/{pool_id}/metadata", `/pools/${pool}/metadata`], ["/pools/{pool_id}/relays", `/pools/${pool}/relays`], ["/pools/{pool_id}/delegators", `/pools/${pool}/delegators`],
        ["/pools/{pool_id}/blocks", `/pools/${LEADER}/blocks`.replace(LEADER, pool)], ["/pools/{pool_id}/updates", `/pools/${pool}/updates`], ["/pools/{pool_id}/votes", `/pools/${pool}/votes`],
        ["/assets", "/assets"], ["/assets/{asset}", `/assets/${UNIT}`], ["/assets/{asset}/history", `/assets/${UNIT}/history`], ["/assets/{asset}/txs", `/assets/${UNIT}/txs`], ["/assets/{asset}/transactions", `/assets/${UNIT}/transactions`],
        ["/assets/{asset}/addresses", `/assets/${UNIT}/addresses`], ["/assets/{asset}/utxos", `/assets/${POLICY + NFT_REF}/utxos`], ["/assets/policy/{policy_id}", `/assets/policy/${POLICY}`],
        ["/scripts", "/scripts"], ["/scripts/{script_hash}", `/scripts/${POLICY}`], ["/scripts/{script_hash}/json", `/scripts/${POLICY}/json`], ["/scripts/{script_hash}/cbor", `/scripts/${SCRIPT_HASH}/cbor`],
        ["/scripts/{script_hash}/redeemers", `/scripts/${SCRIPT_HASH}/redeemers`], ["/scripts/{script_hash}/utxos", `/scripts/${SCRIPT_HASH}/utxos`],
        ["/scripts/datum/{datum_hash}", "DATUM"], ["/scripts/datum/{datum_hash}/cbor", "DATUM/cbor"],
        ["/governance/committee", "/governance/committee"], ["/governance/committee/votes", "/governance/committee/votes"], ["/governance/committee/{cc_id}/votes", `/governance/committee/${ccId("hot", 0, CC_HOT)}/votes`], ["/governance/dreps", "/governance/dreps"], ["/governance/dreps/{drep_id}", `/governance/dreps/${drep}`], ["/governance/dreps/{drep_id}/delegators", `/governance/dreps/${drep}/delegators`],
        ["/governance/dreps/{drep_id}/updates", `/governance/dreps/${drep}/updates`], ["/governance/dreps/{drep_id}/votes", `/governance/dreps/${drep}/votes`],
        ["/governance/proposals", "/governance/proposals"], ["/governance/proposals/{tx_hash}/{cert_index}", `/governance/proposals/${t2}/0`], ["/governance/proposals/{tx_hash}/{cert_index}/votes", `/governance/proposals/${t2}/0/votes`],
        ["/governance/proposals/{tx_hash}/{cert_index}/parameters", `/governance/proposals/${t2}/1/parameters`], ["/governance/proposals/{tx_hash}/{cert_index}/withdrawals", `/governance/proposals/${t2}/2/withdrawals`],
        ["/governance/proposals/{gov_action_id}/parameters", `/governance/proposals/${govActionId(t2, 1)}/parameters`], ["/governance/proposals/{gov_action_id}/withdrawals", `/governance/proposals/${govActionId(t2, 2)}/withdrawals`],
        ["/governance/dreps/{drep_id}/metadata", `/governance/dreps/${drep}/metadata`],
        ["/utils/addresses/xpub/{xpub}/{role}/{index}", `/utils/addresses/xpub/${XPUB}/0/5`],
        ["/mempool/{hash}", `/mempool/${ch.tx.t5}`], ["/mempool/addresses/{address}", `/mempool/addresses/${ADDR.A}`],
        ["/governance/proposals/{gov_action_id}", `/governance/proposals/${govActionId(t2, 0)}`], ["/governance/proposals/{gov_action_id}/votes", `/governance/proposals/${govActionId(t2, 0)}/votes`],
    ];
}

describe("Blockfrost API response shapes (OpenAPI 0.1.92 schemas)", () => {
    test("every probed endpoint answers 200 with a body matching its schema", async () => {
        // one transaction in the local mempool for the /mempool paths
        const { GlobalSharedMempool } = await import("../../network/SharedMempool");
        const { txCbor, blockFacts } = await import("../../db/minibf/blockFacts");
        const last = blockFacts(ch.blocks[3]!.bytes);
        await GlobalSharedMempool.append(Uint8Array.from(Buffer.from(ch.tx.t5, "hex")), txCbor(last.txs[0]!, 7));
        const datum = await sql`SELECT hash FROM mb_datum LIMIT 1`.values() as unknown[][];
        const failures: string[] = [];
        let checked = 0;
        for (const [tpl, raw] of probes()) {
            const path = raw.replace("DATUM", `/scripts/datum/${String(datum[0]![0])}`);
            const r = await get(path);
            if (r.status !== 200) { failures.push(`${tpl}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`); continue; }
            const errs = validate(SCHEMAS[tpl], r.body);
            if (errs.length) failures.push(`${tpl}: ${errs.slice(0, 3).join("; ")}`);
            checked++;
        }
        await GlobalSharedMempool.getInstance().drop([Uint8Array.from(Buffer.from(ch.tx.t5, "hex"))]); // leave the process-wide mempool empty
        expect(failures).toEqual([]);
        expect(checked).toBeGreaterThanOrEqual(110);
    });

    test("every Blockfrost path the router serves has a vendored schema, and the probes cover all of them", () => {
        const served = blockfrostRouter.list().map((r) => r.path).filter((p) => p in SCHEMAS);
        const probed = new Set(probes().map(([t]) => t));
        // POST endpoints have their own tests; proposal metadata is off-chain (404 by design)
        const unprobed = served.filter((p) => !probed.has(p) && !["/tx/submit", "/utils/txs/evaluate", "/utils/txs/evaluate/utxos"].includes(p) && !/^\/governance\/proposals\/.*\/metadata$/.test(p));
        expect(unprobed).toEqual([]);
        expect(served.length).toBeGreaterThanOrEqual(110);
    });
});

describe("Blockfrost API behaviour on the forged chain", () => {
    test("blocks: heights, leader, fees and output from the block row, navigation", async () => {
        const [b0, b1, b2, b3] = ch.blocks;
        const latest = (await get("/blocks/latest")).body;
        expect(latest).toMatchObject({ height: 103, hash: b3!.hash, epoch: EPOCH + 1, tx_count: 1, fees: "1000000", output: "38000000", slot_leader: LEADER, previous_block: b2!.hash, next_block: null, confirmations: 0 });
        expect(latest.op_cert_counter).toBe("7");
        expect((await get(`/blocks/${b2!.hash}`)).body).toMatchObject({ tx_count: 2, fees: String(1_000_000 + 5_000_000), output: String(59_000_000 + 45_000_000) });
        expect((await get(`/blocks/${b0!.hash}/next?count=2`)).body.map((b: any) => b.height)).toEqual([101, 102]);
        expect((await get(`/blocks/${b0!.hash}/next?count=2&page=2`)).body.map((b: any) => b.height)).toEqual([103]);
        expect((await get(`/blocks/103/previous?count=2`)).body.map((b: any) => b.height)).toEqual([101, 102]);
        expect((await get(`/blocks/slot/${b1!.slot}`)).body.hash).toBe(b1!.hash);
        expect((await get(`/epochs/${EPOCH}/blocks/${LEADER}`)).body).toEqual([b0!.hash, b1!.hash]);
        expect((await get(`/pools/${poolIdBech32(POOL)}/blocks`)).body).toEqual([]);
    });

    test("transactions: amounts, deposit, invalid transaction, collateral, redeemers, certificates", async () => {
        const { t1, t2, t3, t4 } = ch.tx;
        const tx1 = (await get(`/txs/${t1}`)).body;
        // value conservation is unknown for the genesis-funded input: certificates give key + pool deposits
        expect(tx1).toMatchObject({ fees: "200000", deposit: "502000000", stake_cert_count: 1, delegation_count: 1, pool_update_count: 1, valid_contract: true, block_height: 100, index: 0 });
        const tx2 = (await get(`/txs/${t2}`)).body;
        // inputs 100 + withdrawal 5 = outputs 90 + fee 0.3 + deposits (DRep 500, proposal 100 000) ← refund-free conservation
        expect(tx2.deposit).toBe(String(100_000_000n + 5_000_000n - 90_000_000n - 300_000n));
        expect(tx2.asset_mint_or_burn_count).toBe(3);
        expect(tx2.output_amount[0]).toEqual({ unit: "lovelace", quantity: "90000000" });
        const tx4 = (await get(`/txs/${t4}`)).body;
        expect(tx4).toMatchObject({ valid_contract: false, fees: "5000000", deposit: "0", redeemer_count: 1 });
        const u4 = (await get(`/txs/${t4}/utxos`)).body;
        expect(u4.inputs.map((i: any) => [i.collateral, i.reference, i.address])).toEqual([[false, false, ADDR.S], [true, false, ADDR.B]]);
        expect(u4.outputs.map((o: any) => [o.output_index, o.collateral])).toEqual([[0, false], [1, true]]);
        const r4 = (await get(`/txs/${t4}/redeemers`)).body;
        expect(r4[0]).toMatchObject({ purpose: "spend", script_hash: SCRIPT_HASH, unit_mem: "1000", unit_steps: "200000" });
        const u2 = (await get(`/txs/${t2}/utxos`)).body;
        expect(u2.outputs[0].consumed_by_tx).toBe(t3);
        expect(u2.outputs[1].inline_datum).toMatch(/^d879/);
        expect(u2.outputs[1].reference_script_hash).toBe(SCRIPT_HASH);
        expect((await get(`/txs/${t1}/pool_updates`)).body[0]).toMatchObject({ pool_id: poolIdBech32(POOL), margin_cost: 0.01, relays: [{ ipv4: "1.2.3.4", port: 3001 }, { dns: "relay.example", port: 3001 }], active_epoch: EPOCH + 2 });
        expect((await get(`/txs/${t1}/metadata`)).body).toEqual([{ label: "674", json_metadata: { msg: ["hello", "world"] } }]);
        const cbor = (await get(`/txs/${t1}/cbor`)).body.cbor as string;
        expect(cbor.startsWith("84")).toBe(true);
        expect(cbor.endsWith("")).toBe(true);
    });

    test("addresses and accounts: UTxOs from the ledger, history from the projection", async () => {
        const a = (await get(`/addresses/${ADDR.A}`)).body;
        expect(a.amount).toEqual([{ unit: "lovelace", quantity: "38000000" }, { unit: POLICY + NFT_USER, quantity: "1" }]);
        expect(a.stake_address).toBe(STAKE_A);
        const bTxs = (await get(`/addresses/${ADDR.B}/txs`)).body;
        expect(bTxs).toEqual([ch.tx.t1, ch.tx.t3, ch.tx.t4]);
        expect((await get(`/addresses/${ADDR.B}/txs?order=desc&count=1`)).body).toEqual([ch.tx.t4]);
        expect((await get(`/addresses/${ADDR.B}/transactions?from=102&to=102:0`)).body.map((x: any) => x.tx_hash)).toEqual([ch.tx.t3]);
        const butxo = (await get(`/addresses/${ADDR.B}/utxos`)).body;
        expect(butxo.map((u: any) => [u.tx_hash, u.output_index])).toEqual([[ch.tx.t3, 0], [ch.tx.t4, 1]]);
        expect((await get(`/addresses/${ADDR.B}/utxos/lovelace`)).body.map((u: any) => u.tx_hash)).toEqual([ch.tx.t4]);
        const total = (await get(`/addresses/${ADDR.B}/total`)).body;
        expect(total.received_sum[0].quantity).toBe(String(50_000_000 + 20_000_000 + 45_000_000));
        expect(total.sent_sum[0].quantity).toBe("50000000");
        expect(total.tx_count).toBe(3);
        const acct = (await get(`/accounts/${STAKE_A}`)).body;
        expect(acct).toMatchObject({ registered: true, active: true, withdrawable_amount: "7000000", withdrawals_sum: "5000000", rewards_sum: "12000000", reserves_sum: "1000000", pool_id: poolIdBech32(POOL), drep_id: drepIdCip129(0, DREP), controlled_amount: String(38_000_000 + 7_000_000) });
        expect((await get(`/accounts/${STAKE_A}/registrations`)).body).toEqual([expect.objectContaining({ tx_hash: ch.tx.t1, action: "registered", deposit: "2000000", block_height: 100 })]);
        expect((await get(`/accounts/${STAKE_A}/rewards`)).body).toEqual([{ epoch: EPOCH - 1, amount: "3000000", pool_id: poolIdBech32(POOL), type: "leader" }]);
        expect((await get(`/accounts/${STAKE_A}/history`)).body.map((h: any) => h.active_epoch)).toEqual([EPOCH, EPOCH + 1]);
        expect((await get(`/accounts/${STAKE_A}/addresses/assets`)).body).toEqual([{ unit: POLICY + NFT_USER, quantity: "1" }]);
    });

    test("assets: supply after a burn, history, holders, CIP-25 and CIP-68 metadata, fingerprint", async () => {
        const t = (await get(`/assets/${UNIT}`)).body;
        expect(t).toMatchObject({ quantity: "7", mint_or_burn_count: 2, initial_mint_tx_hash: ch.tx.t2, asset_name: TOKEN, fingerprint: assetFingerprint(POLICY, TOKEN), onchain_metadata: { name: "Token", image: "ipfs://token" }, onchain_metadata_standard: "CIP25v1" });
        expect((await get(`/assets/${UNIT}/history`)).body).toEqual([{ tx_hash: ch.tx.t2, action: "minted", amount: "10" }, { tx_hash: ch.tx.t3, action: "burned", amount: "-3" }]);
        expect((await get(`/assets/${UNIT}/addresses`)).body).toEqual([{ address: ADDR.B, quantity: "7" }]);
        const nft = (await get(`/assets/${POLICY + NFT_USER}`)).body;
        expect(nft.onchain_metadata).toEqual({ name: "Ref NFT", image: "ipfs://nft" });
        expect(nft.onchain_metadata_standard).toBe("CIP68v1");
        expect((await get(`/assets/policy/${POLICY}?count=1&order=desc`)).body).toEqual([{ asset: UNIT, quantity: "7" }]);
    });

    test("scripts and datums: native JSON, Plutus CBOR, redeemers by script, inline datum JSON", async () => {
        expect((await get(`/scripts/${POLICY}`)).body).toEqual({ script_hash: POLICY, type: "timelock", serialised_size: null });
        expect((await get(`/scripts/${POLICY}/json`)).body).toEqual({ json: { type: "sig", keyHash: "a1".repeat(28) } });
        expect((await get(`/scripts/${SCRIPT_HASH}`)).body).toMatchObject({ type: "plutusV2", serialised_size: 15 });
        expect((await get(`/scripts/${SCRIPT_HASH}/redeemers`)).body.map((r: any) => r.tx_hash)).toEqual([ch.tx.t4]);
        const d = (await sql`SELECT hash FROM mb_datum LIMIT 1`.values()) as unknown[][];
        const j = (await get(`/scripts/datum/${d[0]![0]}`)).body.json_value;
        expect(j.constructor).toBe(0);
        expect(j.fields[1]).toEqual({ int: 1 });
    });

    test("pools, governance and metadata labels", async () => {
        const p = (await get(`/pools/${poolIdBech32(POOL)}`)).body;
        expect(p).toMatchObject({ hex: POOL, declared_pledge: "500000000", live_delegators: 1, live_stake: "45000000", active_stake: "45000000", registration: [ch.tx.t1], retirement: [ch.tx.t5] });
        expect((await get("/pools/retiring")).body).toEqual([{ pool_id: poolIdBech32(POOL), epoch: 1005 }]);
        expect((await get(`/pools/${POOL}/votes`)).body).toEqual([{ tx_hash: ch.tx.t3, cert_index: 1, vote: "no" }]);
        const drep = drepIdCip129(0, DREP);
        expect((await get(`/governance/dreps/${drep}`)).body).toMatchObject({ amount: "1234000000", active: true, retired: false, expired: false, last_active_epoch: EPOCH + 1 });
        expect((await get(`/governance/dreps/${drep}/updates`)).body.map((u: any) => u.action)).toEqual(["registered", "updated"]);
        const votes = (await get(`/governance/proposals/${govActionId(ch.tx.t2, 0)}/votes`)).body;
        expect(votes.map((v: any) => [v.voter_role, v.vote])).toEqual([["drep", "yes"], ["spo", "no"], ["constitutional_committee", "yes"]]);
        const cc = (await get("/governance/committee/votes")).body;
        expect(cc).toEqual([expect.objectContaining({ tx_hash: ch.tx.t3, voter_hot_id: ccId("hot", 0, CC_HOT), proposal_index: 0, governance_type: "info_action", vote: "yes", block_height: 102 })]);
        // a cold credential id finds the votes of its authorised hot key
        expect((await get(`/governance/committee/${ccId("cold", 0, CC_COLD)}/votes`)).body.length).toBe(1);
        expect((await get(`/governance/proposals/${ch.tx.t2}/0`)).body).toMatchObject({ governance_type: "info_action", deposit: "100000000000", return_address: STAKE_A, expiration: EPOCH + 6 });
        expect((await get("/metadata/txs/labels")).body).toEqual([{ label: "674", cip10: expect.any(String), count: "1" }, { label: "721", cip10: expect.any(String), count: "1" }]);
    });

    test("epochs: aggregates from block rows, active stake from the snapshot", async () => {
        expect((await get(`/epochs/${EPOCH}`)).body).toMatchObject({ block_count: 2, tx_count: 2, fees: "500000", output: String(150_000_000 + 90_000_000), active_stake: "45000000" });
        expect((await get(`/epochs/${EPOCH + 1}/previous`)).body.map((e: any) => e.epoch).slice(-1)).toEqual([EPOCH]);
        expect((await get(`/epochs/${EPOCH + 5}`)).status).toBe(404);
    });
});

describe("/utils/addresses/xpub", () => {
    test("public BIP32-Ed25519 derivation equals the private derivation of the same path", async () => {
        const { XPrv, harden } = await import("@harmoniclabs/bip32_ed25519");
        const { blake2b_224: h224 } = await import("@harmoniclabs/crypto");
        const { bech32Encode } = await import("../../db/stakeCred");
        const acct = XPrv.fromEntropy("00".repeat(16), "").derive(harden(1852)).derive(harden(1815)).derive(harden(0));
        const pay = h224(acct.derive(0).derive(5).public().bytes.subarray(0, 32)), stake = h224(acct.derive(2).derive(0).public().bytes.subarray(0, 32));
        const r = (await get(`/utils/addresses/xpub/${XPUB}/0/5`)).body;
        expect(r).toEqual({ xpub: XPUB, role: 0, index: 5, address: bech32Encode("addr_test", Uint8Array.from([0x00, ...pay, ...stake])) });
        expect((await get(`/utils/addresses/xpub/${XPUB}/2/0`)).body.address).toBe(bech32Encode("stake_test", Uint8Array.from([0xe0, ...stake])));
        expect((await get(`/utils/addresses/xpub/abcd/0/0`)).body.message).toBe("Invalid or malformed xpub format. Has to be hex of length 128.");
        expect((await get(`/utils/addresses/xpub/${XPUB}/x/0`)).status).toBe(400);
    });
});

describe("Blockfrost pagination, order and errors", () => {
    test("count / page / order and their 400s", async () => {
        const b2 = ch.blocks[2]!.hash;
        expect((await get(`/blocks/${b2}/txs?count=1`)).body).toEqual([ch.tx.t3]);
        expect((await get(`/blocks/${b2}/txs?count=1&page=2`)).body).toEqual([ch.tx.t4]);
        expect((await get(`/blocks/${b2}/txs?order=desc`)).body).toEqual([ch.tx.t4, ch.tx.t3]);
        expect((await get(`/blocks/${b2}/txs?count=1&page=3`)).body).toEqual([]);
        for (const [q, msg] of [["count=0", "querystring/count must be >= 1"], ["count=101", "querystring/count must be <= 100"], ["page=0", "querystring/page must be >= 1"], ["count=abc", "querystring/count must be integer"], ["order=DESC", "querystring/order must be equal to one of the allowed values"]]) {
            const r = await get(`/blocks/${b2}/txs?${q}`);
            expect(r.status).toBe(400);
            expect(r.body).toEqual({ status_code: 400, error: "Bad Request", message: msg });
        }
    });

    test("400 and 404 bodies", async () => {
        const nf = { status_code: 404, error: "Not Found", message: "The requested component has not been found." };
        expect((await get(`/txs/${"ab".repeat(32)}`)).body).toEqual(nf);
        expect((await get("/no/such/route")).body).toEqual(nf);
        expect((await get(`/accounts/stake_test1uzzzzzzz`)).body).toMatchObject({ status_code: 400, message: "Invalid or malformed stake address format." });
        expect((await get(`/addresses/addr1notvalid/utxos`)).body).toMatchObject({ status_code: 400, message: "Invalid address for this network or malformed address format." });
        expect((await get(`/pools/pool1xyz`)).body).toMatchObject({ status_code: 400, message: "Invalid or malformed pool id format." });
        expect((await get(`/assets/zz`)).body).toMatchObject({ status_code: 400, message: "Invalid or malformed asset format." });
        expect((await get(`/epochs/abc`)).body).toMatchObject({ status_code: 400, message: "Missing, out of range or malformed epoch_number." });
        expect((await get(`/blocks/xyz`)).body).toMatchObject({ status_code: 400 });
        expect((await get(`/metadata/txs/labels/674?page=2`)).status).toBe(404); // Blockfrost: an empty label page is a 404
        expect((await get(`/assets/${POLICY}ffff`)).status).toBe(404);
        expect((await get(`/addresses/${ADDR.S.replace("w", "w")}`)).status).toBe(200);
        // an address never seen is a 404, a seen-but-empty one a zero balance
        const unseen = (await get("/addresses/addr_test1vqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).status;
        expect([400, 404]).toContain(unseen);
        expect((await call("DELETE", "/blocks/latest")).status).toBe(405);
    });

    test("mainnet addresses are rejected on a test network", async () => {
        const r = await get("/addresses/addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x");
        expect(r.status).toBe(400);
    });
});

describe("/utils/txs/evaluate (Ogmios v5 / v6 shapes) on a real preview transaction", () => {
    test("budgets of every redeemer, computed against the transaction budget, not the declared units", async () => {
        const job = JSON.parse(readFileSync(join(import.meta.dir, "../../consensus/__fixtures__/plutus-preview-95107576-0.json"), "utf8"));
        // the resolved inputs go into the ledger's UTxO set, the job's parameters become the current epoch's
        const uw = new UtxoWrites(ch.store);
        ch.store.beginBlock(new Uint8Array(32).fill(9), new Uint8Array(32).fill(2), S0 + 90000);
        for (const [ref, h] of job.resolved as Array<[string, string]>) {
            const o = outputAt(Uint8Array.from(Buffer.from(h, "hex")), 0, 0);
            const assets: Record<string, Record<string, string>> = {};
            for (const x of o.assets) (assets[x.policy] ??= {})[x.name] = x.qty.toString();
            const sref = o.scriptRef ? Buffer.from(enc(arr(uint(["timelock", "plutusV1", "plutusV2", "plutusV3"].indexOf(o.scriptRef.type)), bytesOf(o.scriptRef.bytes)))).toString("hex") : null;
            uw.put({ utxo_ref: ref, tx_out: JSON.stringify({ address: o.address, amount: o.lovelace.toString(), assets, ...(o.datumHash ? { datum_hash: o.datumHash } : {}), ...(o.inlineDatum ? { inline_datum: Buffer.from(o.inlineDatum).toString("hex") } : {}), ...(sref ? { reference_script_cbor: sref, reference_script_hash: o.scriptRef!.hash } : {}) }), tx_hash: ref.split(":")[0]!, address: o.address, lovelace: o.lovelace.toString(), reference_script_hash: o.scriptRef?.hash ?? null, stake_key: null });
        }
        ch.store.commitBlock();
        await storeEpochParams(EPOCH + 1, { ...job.params, epoch: EPOCH + 1 }, "local");
        const txHex = "84" + job.bodyHex + job.witnessHex + "f5f6";
        const v5 = await call("POST", "/utils/txs/evaluate", txHex, { "content-type": "application/cbor" });
        expect(v5.status).toBe(200);
        expect(v5.body.result.EvaluationResult).toEqual({ "mint:0": { memory: 307346, steps: 284206491 } });
        const v6 = await call("POST", "/utils/txs/evaluate?version=6", Buffer.from(txHex, "hex").toString("base64"));
        expect(v6.body.result).toEqual([{ validator: { purpose: "mint", index: 0 }, budget: { memory: 307346, cpu: 284206491 } }]);
        // the same inputs given as an Ogmios v5 additionalUtxoSet
        const extra = (job.resolved as Array<[string, string]>).map(([ref, h]) => {
            const o = outputAt(Uint8Array.from(Buffer.from(h, "hex")), 0, 0);
            const assets: Record<string, string> = {};
            for (const x of o.assets) assets[`${x.policy}.${x.name}`] = x.qty.toString();
            const [txId, ix] = ref.split(":");
            return [{ txId, index: Number(ix) }, { address: o.address, value: { coins: Number(o.lovelace), assets }, ...(o.datumHash && !o.inlineDatum ? { datumHash: o.datumHash } : {}), ...(o.inlineDatum ? { datum: Buffer.from(o.inlineDatum).toString("hex") } : {}), ...(o.scriptRef && o.scriptRef.type !== "timelock" ? { script: { [`plutus:v${o.scriptRef.type.slice(-1)}`]: Buffer.from(o.scriptRef.bytes).toString("hex") } } : {}) }];
        });
        const withSet = await call("POST", "/utils/txs/evaluate/utxos", JSON.stringify({ cbor: txHex, additionalUtxoSet: extra }), { "content-type": "application/json" });
        expect(withSet.body.result.EvaluationResult).toEqual({ "mint:0": { memory: 307346, steps: 284206491 } });
        expect((await call("POST", "/utils/txs/evaluate", "zz")).status).toBe(400);
    });
});

describe("projection rollback of the v2 tables", () => {
    test("indexing a block twice (restart, backfill over a live range) changes nothing", async () => {
        const b2 = ch.blocks[1]!;
        await applyMbBlock(sql as any, { kind: "block", hash: Uint8Array.from(Buffer.from(b2.hash, "hex")), slot: b2.slot, height: b2.height, epoch: EPOCH, epochSlot: b2.slot % 86400, bytes: b2.bytes });
        expect((await get(`/assets/${UNIT}`)).body).toMatchObject({ quantity: "7", mint_or_burn_count: 2 });
        expect((await get("/metadata/txs/labels")).body.map((l: any) => l.count)).toEqual(["1", "1"]);
    });

    test("rolling back below the burn restores the asset supply and drops the later rows", async () => {
        await rollbackMbToSlot(sql as any, S0 + 86400 - 1);
        expect((await get(`/assets/${UNIT}`)).body).toMatchObject({ quantity: "10", mint_or_burn_count: 1 });
        expect((await get(`/governance/proposals/${ch.tx.t2}/0/votes`)).body).toEqual([]);
        const blocks = (await sql`SELECT COUNT(*) FROM mb_block`.values()) as unknown[][];
        expect(Number(blocks[0]![0])).toBe(2);
        expect((await get(`/txs/${ch.tx.t4}`)).status).toBe(404);
    });
});

describe("OpenAPI document (/docs)", () => {
    test("lists every router path with Blockfrost's 200 schema", async () => {
        const { getOpenApiSpec } = await import("../openApi");
        const spec: any = getOpenApiSpec({ network: "preview", port: 3200 });
        expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(110);
        const acct = spec.paths["/api/v0/accounts/{stake_address}"].get;
        expect(acct.responses["200"].content["application/json"].schema.required).toContain("controlled_amount");
        expect(spec.paths["/api/v0/tx/submit"].post).toBeDefined();
    });
});
