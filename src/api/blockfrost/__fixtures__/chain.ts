/**
 * A small forged Conway chain on preview geometry (epochs 1000–1001) with a matching LMDB ledger
 * store, for the Blockfrost API tests: payments, a native-script mint and burn (CIP-25 and CIP-68
 * tokens), metadata, stake registration and delegation, a pool registration with relays and its
 * retirement, a withdrawal, a MIR transfer, a DRep registration / update and vote delegation, a
 * proposal and votes, a reference script, inline datums, and a phase-2-invalid transaction with
 * collateral return. Blocks go into the SQLite `blocks` table and the projection via the same
 * writer the explorer worker runs (deltas + block facts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, CborSimple, CborTag, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { initSql, sql } from "../../../sql";
import { ensureInitialized, insertBlockVolatile } from "../../../db";
import { storeEpochParams } from "../../../consensus/epochParams";
import { LedgerStore } from "../../../ledger/LedgerStore";
import { StakeWrites, noteRawPoolParams } from "../../../ledger/stakeStore";
import { GovWrites } from "../../../ledger/govStore";
import { UtxoReads, UtxoWrites } from "../../../ledger/utxoStore";
import { blockFacts, scriptHash } from "../../../db/minibf/blockFacts";
import { deltasOfBlock } from "../../../db/minibf/blockDeltas";
import { applyMbBlock, applyMbTx } from "../../../db/minibf/writer";
import { bech32Encode } from "../../../db/stakeCred";
import { hex } from "../../../db/minibf/cborWalk";
import { setBlockfrostLedger } from "../ledger";
import { setEpochNetwork } from "../../../utils/epochFromSlotCalculations";
import params841 from "../../../consensus/__fixtures__/preview-params-841.json";

// ---------------------------------------------------------------- CBOR builders
export const u = (n: number | bigint) => (BigInt(n) < 0n ? new CborNegInt(BigInt(n)) : new CborUInt(BigInt(n)));
export const b = (x: Uint8Array | string) => new CborBytes(typeof x === "string" ? Uint8Array.from(Buffer.from(x, "hex")) : x);
export const t = (s: string) => new CborText(s);
export const a = (...xs: CborObj[]) => new CborArray(xs);
export const m = (...kv: Array<[CborObj, CborObj]>) => new CborMap(kv.map(([k, v]) => ({ k, v })));
export const tag = (n: number, d: CborObj) => new CborTag(n, d);
export const nul = () => CborSimple.null;
export const enc = (o: CborObj): Uint8Array => Cbor.encode(o).toBuffer();
const fill = (byte: number, n: number) => new Uint8Array(n).fill(byte);
const h28 = (byte: number) => hex(fill(byte, 28));

// ---------------------------------------------------------------- actors
export const A_PAY = h28(0xa1), A_STAKE = h28(0x5a), B_PAY = h28(0xb1), DREP = h28(0xd0), POOL = h28(0xb0), VRF = hex(fill(0x76, 32));
export const CC_COLD = h28(0xc0), CC_HOT = h28(0xc1);
export const NATIVE = enc(a(u(0), b(A_PAY))); // sig(A)
export const POLICY = scriptHash("timelock", NATIVE);
export const PLUTUS = enc(b("4e4d01000033222220051200120011")); // the witness byte string holding a tiny flat program
export const PLUTUS_BYTES = Uint8Array.from(Buffer.from("4e4d01000033222220051200120011", "hex"));
export const SCRIPT_HASH = scriptHash("plutusV2", PLUTUS_BYTES);
export const addrRaw = {
    A: Uint8Array.from([0x00, ...fill(0xa1, 28), ...fill(0x5a, 28)]),
    B: Uint8Array.from([0x60, ...fill(0xb1, 28)]),
    S: Uint8Array.from([0x70, ...Buffer.from(SCRIPT_HASH, "hex")]),
};
export const ADDR = { A: bech32Encode("addr_test", addrRaw.A), B: bech32Encode("addr_test", addrRaw.B), S: bech32Encode("addr_test", addrRaw.S) };
export const STAKE_A = bech32Encode("stake_test", Uint8Array.from([0xe0, ...fill(0x5a, 28)]));
const rewardAcct = Uint8Array.from([0xe0, ...fill(0x5a, 28)]);
export const TOKEN = "746f6b656e"; // "token"
export const NFT_USER = "000de140" + "6e6674", NFT_REF = "000643b0" + "6e6674";
export const EPOCH = 1000, S0 = EPOCH * 86400 + 100;
const ADA = 1_000_000n;

// ---------------------------------------------------------------- transactions
const input = (tx: string, ix: number) => a(b(tx), u(ix));
const value = (lovelace: bigint, assets?: Array<[string, string, bigint]>) => {
    if (!assets?.length) return u(lovelace);
    const byPolicy = new Map<string, Array<[string, bigint]>>();
    for (const [p, n, q] of assets) { const l = byPolicy.get(p) ?? []; l.push([n, q]); byPolicy.set(p, l); }
    return a(u(lovelace), m(...[...byPolicy].map(([p, ns]) => [b(p), m(...ns.map(([n, q]) => [b(n), u(q)] as [CborObj, CborObj]))] as [CborObj, CborObj])));
};
const out = (addr: Uint8Array, v: CborObj, extra: Array<[number, CborObj]> = []) => m([u(0), b(addr)], [u(1), v], ...extra.map(([k, x]) => [u(k), x] as [CborObj, CborObj]));
const keyCred = (h: string) => a(u(0), b(h));
const anchor = (url: string) => a(t(url), b(hex(fill(0xee, 32))));
const vkeyWit = () => m([u(0), tag(258, a(a(b(hex(fill(0x01, 32))), b(hex(fill(0x02, 64))))))]);

export interface ForgedTx { body: CborObj; witness: CborObj; aux?: CborObj; valid?: boolean }
export const txHash = (tx: ForgedTx) => hex(blake2b_256(enc(tx.body)));

function forgeBlock(no: number, slot: number, prev: string, txs: ForgedTx[]): { bytes: Uint8Array; hash: string } {
    const hb = a(u(no), u(slot), b(prev), b(hex(fill(0x99, 32))), b(hex(fill(0x76, 32))), a(b(hex(fill(1, 64))), b(hex(fill(2, 80)))), u(1000), b(hex(fill(3, 32))), a(b(hex(fill(0x0c, 32))), u(7), u(10), b(hex(fill(4, 64)))), a(u(10), u(0)));
    const header = a(hb, b(hex(fill(5, 448))));
    const auxEntries: Array<[CborObj, CborObj]> = [];
    txs.forEach((x, i) => { if (x.aux) auxEntries.push([u(i), x.aux]); });
    const invalid = txs.map((x, i) => (x.valid === false ? i : -1)).filter((i) => i >= 0);
    const block = a(header, a(...txs.map((x) => x.body)), a(...txs.map((x) => x.witness)), m(...auxEntries), a(...invalid.map((i) => u(i))));
    const bytes = enc(a(u(7), block));
    return { bytes, hash: hex(blake2b_256(enc(header))) };
}

export const GENESIS_TX = hex(fill(0x47, 32));

function chainTxs() {
    // tx1: funds A and B, registers A's stake key and pool P, delegates A to P, metadata 674
    const poolParams = a(b(POOL), b(VRF), u(500n * ADA), u(340n * ADA), tag(30, a(u(1), u(100))), b(rewardAcct), tag(258, a(b(A_STAKE))),
        a(a(u(0), u(3001), b("01020304"), nul()), a(u(1), u(3001), t("relay.example"))), a(t("https://pool.example/meta.json"), b(hex(fill(0xab, 32)))));
    const tx1: ForgedTx = {
        body: m([u(0), tag(258, a(input(GENESIS_TX, 0)))], [u(1), a(out(addrRaw.A, value(100n * ADA)), out(addrRaw.B, value(50n * ADA)))], [u(2), u(200_000)],
            [u(4), tag(258, a(a(u(0), keyCred(A_STAKE)), a(u(3), ...poolParams.array), a(u(2), keyCred(A_STAKE), b(POOL))))], [u(7), b(hex(fill(0x0a, 32)))]),
        witness: vkeyWit(),
        aux: tag(259, m([u(0), m([u(674), m([t("msg"), a(t("hello"), t("world"))])])])),
    };
    const t1 = txHash(tx1);
    // tx2: A mints token ×10 and the CIP-68 pair, pays the script address (inline datum + reference script), withdraws, registers DRep D,
    //      delegates A's vote to D, proposes an info action; label 721
    const utf8 = (x: string) => b(Buffer.from(x).toString("hex"));
    const refDatum = tag(121, a(m([utf8("name"), utf8("Ref NFT")], [utf8("image"), utf8("ipfs://nft")]), u(1)));
    const tx2: ForgedTx = {
        body: m([u(0), tag(258, a(input(t1, 0)))],
            [u(1), a(
                out(addrRaw.A, value(60n * ADA, [[POLICY, TOKEN, 10n], [POLICY, NFT_USER, 1n]])),
                out(addrRaw.S, value(30n * ADA, [[POLICY, NFT_REF, 1n]]), [[2, a(u(1), tag(24, b(enc(refDatum))))], [3, tag(24, b(enc(a(u(2), b(PLUTUS_BYTES)))))]]),
            )],
            [u(2), u(300_000)], [u(5), m([b(rewardAcct), u(5n * ADA)])],
            [u(4), tag(258, a(a(u(16), keyCred(DREP), u(500n * ADA), anchor("https://drep.example")), a(u(9), keyCred(A_STAKE), a(u(0), b(DREP)))))],
            [u(9), m([b(POLICY), m([b(TOKEN), u(10)], [b(NFT_USER), u(1)], [b(NFT_REF), u(1)])])],
            [u(14), tag(258, a(b(A_PAY)))],
            [u(20), tag(258, a(
                a(u(100_000n * ADA), b(rewardAcct), a(u(6)), anchor("https://gov.example/p1")),
                a(u(100_000n * ADA), b(rewardAcct), a(u(0), nul(), m([u(0), u(45)]), nul()), anchor("https://gov.example/p2")),
                a(u(100_000n * ADA), b(rewardAcct), a(u(2), m([b(rewardAcct), u(1000n * ADA)]), nul()), anchor("https://gov.example/p3")),
            ))]),
        witness: m([u(0), tag(258, a(a(b(hex(fill(0x01, 32))), b(hex(fill(0x02, 64))))))], [u(1), tag(258, a(Cbor.parse(NATIVE)))]),
        aux: tag(259, m([u(0), m([u(721), m([t(POLICY), m([t("token"), m([t("name"), t("Token")], [t("image"), t("ipfs://token")])])])])])),
    };
    const t2 = txHash(tx2);
    // tx3 (epoch 1001): A burns 3 token, pays B; D votes yes and P votes no on tx2's proposal
    const tx3: ForgedTx = {
        body: m([u(0), tag(258, a(input(t2, 0)))], [u(1), a(out(addrRaw.B, value(20n * ADA, [[POLICY, TOKEN, 7n]])), out(addrRaw.A, value(39n * ADA, [[POLICY, NFT_USER, 1n]])))], [u(2), u(1_000_000)],
            [u(9), m([b(POLICY), m([b(TOKEN), u(-3)])])],
            [u(19), m([a(u(2), b(DREP)), m([a(b(t2), u(0)), a(u(1), anchor("https://vote.example"))])], [a(u(4), b(POOL)), m([a(b(t2), u(0)), a(u(0), nul())])], [a(u(0), b(CC_HOT)), m([a(b(t2), u(0)), a(u(1), nul())])])]),
        witness: m([u(1), tag(258, a(Cbor.parse(NATIVE)))]),
    };
    const t3 = txHash(tx3);
    // tx4 (same block, phase-2 invalid): tries to spend the script output; collateral B's 50 ADA, 45 back
    const tx4: ForgedTx = {
        body: m([u(0), tag(258, a(input(t2, 1)))], [u(1), a(out(addrRaw.A, value(29n * ADA)))], [u(2), u(500_000)],
            [u(13), tag(258, a(input(t1, 1)))], [u(16), out(addrRaw.B, value(45n * ADA))], [u(17), u(5n * ADA)]),
        witness: m([u(5), m([a(u(0), u(0)), a(u(42), a(u(1000), u(200000)))])], [u(6), a(b(PLUTUS_BYTES))]),
        valid: false,
    };
    const t4 = txHash(tx4);
    // tx5 (next block): retires P at 1005, updates D, a MIR to A, spends A's change
    const tx5: ForgedTx = {
        body: m([u(0), tag(258, a(input(t3, 1)))], [u(1), a(out(addrRaw.A, value(38n * ADA, [[POLICY, NFT_USER, 1n]])))], [u(2), u(1_000_000)],
            [u(4), tag(258, a(a(u(4), b(POOL), u(1005)), a(u(18), keyCred(DREP), anchor("https://drep.example/v2")), a(u(6), a(u(0), m([keyCred(A_STAKE), u(ADA)]))), a(u(14), keyCred(CC_COLD), keyCred(CC_HOT))))]),
        witness: vkeyWit(),
    };
    return { tx1, tx2, tx3, tx4, tx5, t1, t2, t3, t4, t5: txHash(tx5), poolParams: enc(poolParams) };
}

export interface FixtureChain {
    dir: string;
    blocks: Array<{ hash: string; slot: number; height: number; bytes: Uint8Array }>;
    tx: ReturnType<typeof chainTxs>;
    store: LedgerStore;
    close(): Promise<void>;
}

/** Build the chain into a fresh SQLite + LMDB pair and point the API at it. */
export async function buildFixtureChain(): Promise<FixtureChain> {
    const dir = mkdtempSync(join(tmpdir(), "gerolamo-bf-"));
    setEpochNetwork("preview");
    initSql(join(dir, "ledger.db"));
    await ensureInitialized();
    for (const e of [EPOCH - 1, EPOCH, EPOCH + 1]) await storeEpochParams(e, { ...(params841 as any), epoch: e }, "local");
    const tx = chainTxs();
    const plan: Array<{ slot: number; txs: ForgedTx[] }> = [
        { slot: S0, txs: [tx.tx1] },
        { slot: S0 + 100, txs: [tx.tx2] },
        { slot: S0 + 86400, txs: [tx.tx3, tx.tx4] },
        { slot: S0 + 86400 + 50, txs: [tx.tx5] },
    ];
    const blocks: FixtureChain["blocks"] = [];
    let prev = hex(fill(0, 32));
    let height = 100;
    const outAddr = new Map<string, string>();
    for (const p of plan) {
        const f = forgeBlock(height, p.slot, prev, p.txs);
        const hashBytes = Uint8Array.from(Buffer.from(f.hash, "hex"));
        await insertBlockVolatile({ slot: BigInt(p.slot), blockHash: f.hash, prevHash: prev, blockNo: height, headerData: new Uint8Array([1]), blockData: f.bytes } as any);
        const facts = blockFacts(f.bytes);
        const deltas = await deltasOfBlock(facts, { hash: hashBytes, slot: p.slot, height }, (h, i) => outAddr.get(`${h}:${i}`) ?? null);
        for (const d of deltas) { await applyMbTx(sql as any, d); for (const o of d.outputs) outAddr.set(`${d.txHash}:${o.outputIndex}`, o.address); }
        await applyMbBlock(sql as any, { kind: "block", hash: hashBytes, slot: p.slot, height, epoch: Math.floor(p.slot / 86400), epochSlot: p.slot % 86400, bytes: f.bytes }, facts);
        blocks.push({ hash: f.hash, slot: p.slot, height, bytes: f.bytes });
        prev = f.hash; height++;
    }

    // ---- the ledger store at the tip
    const store = LedgerStore.open(join(dir, "lmdb"), { mapSize: 64 * 1024 * 1024 });
    await store.setAnchor({ slot: 0, hash: fill(0, 32) });
    const sw = new StakeWrites(store), gw = new GovWrites(store), uw = new UtxoWrites(store);
    store.beginBlock(fill(1, 32), fill(0, 32), S0);
    sw.initPots(EPOCH - 2, 14_000_000_000n * ADA);
    sw.putPots({ reserves: 14_000_000_000n * ADA, treasury: 1_000_000_000n * ADA, feePot: 0n, donationPot: 0n, initializedEpoch: EPOCH - 2 });
    sw.registerStake(A_STAKE);
    noteRawPoolParams(POOL, tx.poolParams);
    sw.recordPoolRegistration(POOL, VRF, S0, { pledge: String(500n * ADA), cost: String(340n * ADA), marginNum: "1", marginDen: "100", rewardAccount: A_STAKE, owners: [A_STAKE] });
    sw.delegate(A_STAKE, POOL);
    sw.creditRewards(new Map([[A_STAKE, 7n * ADA]]));
    // current UTxO set: replay the projection's unspent outputs
    const unspent = (await sql`SELECT tx_hash, output_index, address, lovelace, assets_json, datum_hash, inline_datum_cbor, script_ref_hash, stake_cred FROM mb_tx_out WHERE spent_by_tx IS NULL`.values()) as unknown[][];
    for (const r of unspent) {
        const assets = r[4] ? JSON.parse(String(r[4])) : {};
        uw.put({ utxo_ref: `${r[0]}:${r[1]}`, tx_out: JSON.stringify({ address: r[2], amount: String(r[3]), assets, ...(r[5] ? { datum_hash: r[5] } : {}), ...(r[6] ? { inline_datum: r[6] } : {}), ...(r[7] ? { reference_script_hash: r[7] } : {}) }), tx_hash: String(r[0]), address: String(r[2]), lovelace: String(r[3]), reference_script_hash: r[7] == null ? null : String(r[7]), stake_key: r[8] == null ? null : String(r[8]) });
    }
    gw.putDRep(DREP, { isScript: 0, deposit: String(500n * ADA), registeredSlot: S0 + 100, lastActiveEpoch: EPOCH + 1, expiryEpoch: EPOCH + 21 });
    gw.putDRepDelegation(A_STAKE, { type: 0, hash: DREP });
    gw.putProposal({ actionId: `${tx.t2}:0`, seq: 1, kind: "Info", prevActionId: null, deposit: String(100_000n * ADA), returnAccount: A_STAKE, payload: "{}", proposedEpoch: EPOCH, expiresEpoch: EPOCH + 6, status: "active", decidedEpoch: null });
    gw.putProposal({ actionId: `${tx.t2}:1`, seq: 2, kind: "ParameterChange", prevActionId: null, deposit: String(100_000n * ADA), returnAccount: A_STAKE, payload: JSON.stringify({ changes: { min_fee_a: 45 }, policy: null }), proposedEpoch: EPOCH, expiresEpoch: EPOCH + 6, status: "ratified", decidedEpoch: EPOCH + 1 });
    gw.putProposal({ actionId: `${tx.t2}:2`, seq: 3, kind: "TreasuryWithdrawals", prevActionId: null, deposit: String(100_000n * ADA), returnAccount: A_STAKE, payload: JSON.stringify({ withdrawals: [{ account: A_STAKE, amount: String(1000n * ADA) }], policy: null }), proposedEpoch: EPOCH, expiresEpoch: EPOCH + 6, status: "expired", decidedEpoch: EPOCH + 1 });
    gw.putCommittee(CC_COLD, { expiresEpoch: EPOCH + 50, hot: null, resigned: 0 });
    gw.putCommitteeAuth(CC_COLD, { hot: CC_HOT, resigned: 0 });
    gw.putState({ thrNum: 2, thrDen: 3, constitutionHash: null, constitutionScript: null, noConfidence: 0, prevPP: null, prevHF: null, prevCC: null, prevCons: null, seededEpoch: EPOCH - 2, dormantEpochs: 0, pending: null });
    store.commitBlock();
    // the epoch boundary into 1001: snapshot (taken at 1000 → active stake of 1001), rewards of epoch 999, DRep stake
    store.beginBlock(fill(2, 32), fill(1, 32), S0 + 86400);
    sw.takeStakeSnapshot(EPOCH);
    sw.takeStakeSnapshot(EPOCH - 1);
    sw.recordRewardPayouts(EPOCH - 1, new Map([[A_STAKE, 3n * ADA]]));
    gw.putDRepStake(EPOCH + 1, 0, DREP, 1234n * ADA);
    sw.recordPoolRetirement(POOL, 1005);
    store.commitBlock();
    setBlockfrostLedger({ stake: sw.reads, gov: gw.reads, utxo: new UtxoReads(store) });
    return {
        dir, blocks, tx, store,
        async close() { setBlockfrostLedger(undefined); try { store.close?.(); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}
export { blake2b_224 };
