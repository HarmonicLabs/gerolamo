import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { Address, Credential, CredentialType, DijkstraBlock, DijkstraHeader, MultiEraBlock, MultiEraHeader, PubKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { headerParser, localRollForwardMessage } from "../blockHeaderParser";
import { tieBreakInfoOf, vrfFlavorForEra } from "../tieBreak";
import { validateHeader } from "../BlockHeaderValidator";
import { verifyBlockBodyHash } from "../bodyHash";
import { experimentalHardForksEnabled, lastReachableEra, setExperimentalHardForks } from "../hfc/experimental";
import { triggersFrom } from "../hfc/HardForkHistory";
import { eraIndexAt } from "../hfc/eraOfTip";
import { checkDijkstraBlock, checkDijkstraTx, dijkstraBatchValue, dijkstraBlockAuxDataBytes, dijkstraRefScriptParams, plutusLegacyMode, rewardBytesKey } from "../rules/dijkstraRules";
import { evaluateTxRules, type TxRuleParams } from "../rules/txRules";
import type { ResolvedUtxo } from "../rules/resolvedUtxo";
import { dijkstraBlockBodyFromSegments, forgeBlock, EMPTY_BODY } from "../../pool/forge";
import { issueOperationalCert, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey } from "../../pool/keystore";
import { paramChangesOfUpdateMap } from "../governance/costModelUpdate";
import { dijkstraPParamsCbor, pparamsCborFor } from "../../network/n2c/pparamsCbor";
import { dijkstraGenesisRaw } from "../pparams";
import { witnessScriptHashes, scriptLanguageOfCbor, languageViews } from "../rules/scriptDataHash";

const FIX = (n: string) => new URL(`../__fixtures__/dijkstra/${n}`, import.meta.url).pathname;
const hexFile = (n: string) => readFileSync(FIX(n), "utf8").replace(/\s+/g, "");
const blockBytes = fromHex(hexFile("musashi_type8_dijkstra_block.hex"));
const headerBytes = fromHex(hexFile("musashi_type8_dijkstra_header.hex"));
/** `[8, block]` as BlockFetch serves a Dijkstra block (raw concatenation: no CborObj crosses into ledger-ts). */
const wrap8 = (b: Uint8Array) => { const o = new Uint8Array(b.length + 2); o[0] = 0x82; o[1] = 0x08; o.set(b, 2); return o; };
const musashiConfig = { networkMagic: 164, shelleyGenesisFile: FIX("musashi-shelley-genesis.json") };

afterEach(() => setExperimentalHardForks(false));

describe("ExperimentalHardForksEnabled (bug 421)", () => {
    test("off by default: Conway is the last reachable era and its successor never comes", () => {
        expect(experimentalHardForksEnabled()).toBe(false);
        expect(lastReachableEra()).toBe(6);
        expect(triggersFrom({}, "preview")[7]).toEqual({ kind: "never" });
        expect(eraIndexAt(null, 10_000_000n, 7)).toBe(6);
    });
    test("the cardano-node key turns Dijkstra on: protocol 12 triggers it", () => {
        const t = triggersFrom({ ExperimentalHardForksEnabled: true }, "preview");
        expect(t[6]).toEqual({ kind: "version", major: 9 });
        expect(t[7]).toEqual({ kind: "version", major: 12 });
        expect(experimentalHardForksEnabled()).toBe(true);
        expect(eraIndexAt(null, 10_000_000n, 7)).toBe(7);
        expect(triggersFrom({ ExperimentalHardForksEnabled: true, TestDijkstraHardForkAtEpoch: 3 })[7]).toEqual({ kind: "epoch", epoch: 3n });
    });
});

describe("Dijkstra headers (bug 425)", () => {
    test("ChainSync: an era-7 header is ignored without the switch and parsed with it", async () => {
        const rf = localRollForwardMessage(wrap8(blockBytes));
        expect(rf.era).toBe(8);
        expect(await headerParser(rf.bytes)).toBeNull();
        setExperimentalHardForks(true);
        const parsed = await headerParser(rf.bytes);
        expect(parsed).not.toBeNull();
        expect(parsed!.era).toBe(8);
        expect(parsed!.slot).toBe(86407n);
        expect(toHex(parsed!.blockHeaderHash)).toBe(toHex(blake2b_256(headerBytes)));
        expect(parsed!.multiEraHeader.header instanceof DijkstraHeader).toBe(true);
    });
    test("chain selection reads the tie-break fields of a 12-field header (restricted VRF, as Conway)", () => {
        const t = tieBreakInfoOf(headerBytes)!;
        expect(t).not.toBeNull();
        expect(t.slot).toBe(86407n);
        expect(t.opcertCounter).toBe(0n);
        expect(t.vrfOutput.length).toBe(64);
        expect(vrfFlavorForEra(7)).toEqual({ restricted: true, maxDist: 5n });
    });
    test("a live musashi header (slot 566037) passes KES and opcert checks (VRF skipped: no epoch nonce)", async () => {
        const legacy = fromHex(hexFile("musashi_legacy_block_566037.hex"));
        const hdr = (Cbor.parseLazy(legacy) as any).array[0] as Uint8Array;
        const meh = MultiEraHeader.fromCbor(wrap8(hdr));
        expect(meh.era).toBe(8);
        expect(await validateHeader(meh, new Uint8Array(32), musashiConfig, { skipVrf: true })).toBe(true);
        const bad = Uint8Array.from(hdr); bad[bad.length - 1]! ^= 1;
        expect(await validateHeader(MultiEraHeader.fromCbor(wrap8(bad)), new Uint8Array(32), musashiConfig, { skipVrf: true })).toBe(false);
    });
});

describe("Dijkstra block bodies (bug 426)", () => {
    test("body hash and size of the live musashi block", () => {
        const r = verifyBlockBodyHash(wrap8(blockBytes));
        expect(r.ok).toBe(true);
        expect(r.era).toBe(8);
        expect(r.expected).toBe(r.actual);
    });
    test("a body that does not match its header fails (hash and size)", () => {
        // replace `[[], nil, nil]` (83 80 f6 f6) with `[[], nil, h'00']`
        const tail = blockBytes.length - 4;
        expect(toHex(blockBytes.subarray(tail))).toBe("8380f6f6");
        const tampered = new Uint8Array(blockBytes.length + 1); tampered.set(blockBytes.subarray(0, tail)); tampered.set([0x83, 0x80, 0xf6, 0x41, 0x00], tail);
        const r = verifyBlockBodyHash(wrap8(tampered));
        expect(r.ok).toBe(false);
        expect(r.detail).toContain("block_body_size 4");
    });
    test("MultiEraBlock gives Conway-shaped views of a Dijkstra block", () => {
        const meb = MultiEraBlock.fromCbor(wrap8(blockBytes));
        const b = meb.block as DijkstraBlock;
        expect(meb.era).toBe(8);
        expect(b.transactionBodies).toEqual([]);
        expect(b.invalidTransactions).toEqual([]);
    });
});

describe("forging a Dijkstra block (bug 425)", () => {
    const K = (n: string) => new URL(`../../pool/__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
    const nonce = fromHex("aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c");
    const config = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };
    test("an empty era-8 block: 12-field header our validator accepts, body hash over block_body", async () => {
        const slot = 333n * 86400n + 4242n;
        const cold = loadColdSigningKey(K("cold.skey")), kes = loadKesSigningKey(K("kes.skey"), K("kes.vkey")), vrf = loadVrfSigningKey(K("vrf.skey"), K("vrf.vkey"));
        const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, slot / 129600n - 2n, cold);
        const forged = forgeBlock({ era: 8, blockNumber: 10n, slot, prevHash: new Uint8Array(32).fill(7), nonce, coldVkey: cold.vkey, vrf, kes, opcert: opcert.cert, protocolVersion: { major: 12, minor: 0 }, slotsPerKESPeriod: 129600n });
        const hdr = Cbor.parse(forged.headerBytes) as CborArray;
        expect((hdr.array[0] as CborArray).array.length).toBe(12);
        expect(forged.blockFetchBytes[1]).toBe(8);
        expect(verifyBlockBodyHash(forged.blockFetchBytes).ok).toBe(true);
        const meb = MultiEraBlock.fromCbor(forged.blockFetchBytes);
        expect((meb.block as DijkstraBlock).transactions.length).toBe(0);
        const meh = MultiEraHeader.fromCbor(wrap8(forged.headerBytes));
        expect(await validateHeader(meh, nonce, config)).toBe(true);
        expect(await validateHeader(meh, new Uint8Array(32), config)).toBe(false); // wrong nonce: VRF fails
    });
    test("segments → block_body: each tx as [body, wits, aux / nil, is_valid]", () => {
        const body = Cbor.encode(new CborMap([{ k: new CborUInt(0), v: new CborArray([]) }, { k: new CborUInt(1), v: new CborArray([]) }, { k: new CborUInt(2), v: new CborUInt(0) }])).toBuffer();
        const seg = { txBodies: new Uint8Array([0x82, ...body, ...body]), witnessSets: new Uint8Array([0x82, 0xa0, 0xa0]), auxiliaryData: new Uint8Array([0xa1, 0x01, 0xa0]), invalidTransactions: new Uint8Array([0x81, 0x00]) };
        const bb = dijkstraBlockBodyFromSegments(seg);
        const parsed = Cbor.parse(bb) as CborArray;
        const txs = (parsed.array[0] as CborArray).array as CborArray[];
        expect(txs.length).toBe(2);
        expect((txs[0]!.array[3] as CborSimple).simple).toBe(false); // index 0 invalid
        expect((txs[1]!.array[3] as CborSimple).simple).toBe(true);
        expect(txs[0]!.array[2] instanceof CborSimple).toBe(true); // no aux for tx 0
        expect(txs[1]!.array[2] instanceof CborMap).toBe(true);
        expect(toHex(dijkstraBlockBodyFromSegments(EMPTY_BODY))).toBe("8380f6f6");
    });
});

// ---------------------------------------------------------------- rules (bugs 427, 428)

const KEY_A = "aa".repeat(28), KEY_B = "bb".repeat(28), TXH = "cd".repeat(32), SUBH = "ef".repeat(32);
const addrOf = (keyHex: string) => Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(keyHex)) })).toString();
const params: TxRuleParams = { minFeeA: 44n, minFeeB: 155381n, keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, maxTxSize: 16384, minUtxoValue: null, coinsPerUtxoByte: null, coinsPerUtxoWord: null, minFeeRefScriptCostPerByte: null, priceMem: null, priceStep: null, network: "mainnet", collateralPercent: 150, maxCollateralInputs: 3, maxTxExMem: null, maxTxExSteps: null };
const utxo = (ref: string, address: string, lovelace: bigint): ResolvedUtxo => ({ ref, address, value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const out = (address: string, lovelace: bigint) => ({ address: Address.fromString(address), value: Value.lovelaces(lovelace) });
const rewardMap = (keyHex: string, amount: bigint) => ({ map: [{ rewardAccount: { type: "stakeKey", network: "mainnet", credentials: { toString: () => keyHex } }, amount }] });
const resolved = () => new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)], [`${TXH}:1`, utxo(`${TXH}:1`, addrOf(KEY_A), 3_000_000n)]]);
function run(body: any, overrides: Partial<Parameters<typeof evaluateTxRules>[0]> = {}) {
    return evaluateTxRules({
        era: 8, body: { inputs: [input(`${TXH}:0`)], fee: 200_000n, ...body }, witnessSet: {}, slot: 1000n, resolved: resolved(),
        provenKeys: new Set([KEY_A]), provenRoots: new Set(), isPoolRegistered: () => false, params, txSizeBytes: 300,
        rewardBalances: new Map([[KEY_B, 5_000_000n]]), stakeRegistered: (k) => k === KEY_B, exactness: { exact: true, why: "" }, ...overrides,
    });
}
const conserved = (r: { failures: string[] }) => !r.failures.some((f) => f.startsWith("value not conserved"));

describe("Dijkstra transaction rules (bug 428)", () => {
    test("value is conserved over the batch: sub-transaction inputs and outputs, direct deposits", () => {
        const sub = { body: { hash: SUBH, inputs: [input(`${TXH}:1`)], outputs: [out(addrOf(KEY_B), 2_000_000n)] } };
        // consumed 10 + 3; produced 9.8 - 1 (deposit) … top outputs 7.8 + sub 2 + deposit 3 + fee 0.2 = 13
        const body = { outputs: [out(addrOf(KEY_B), 7_800_000n)], subTransactions: [sub], directDeposits: rewardMap(KEY_B, 3_000_000n) };
        expect(conserved(run(body))).toBe(true);
        expect(conserved(run({ ...body, directDeposits: rewardMap(KEY_B, 2_000_000n) }))).toBe(false);
        // a sub-transaction input outside the UTxO before the batch fails
        const r = run({ ...body, subTransactions: [{ body: { ...sub.body, inputs: [input(`${TXH}:9`)] } }] });
        expect(r.failures.some((f) => f.startsWith("sub-transactions spend 1 input(s)"))).toBe(true);
    });
    test("withdrawals may be partial outside legacy mode, never above the balance", () => {
        const partial = { outputs: [out(addrOf(KEY_B), 11_800_000n)], withdrawals: rewardMap(KEY_B, 2_000_000n) };
        expect(run(partial, { provenKeys: new Set([KEY_A, KEY_B]) }).failures).toEqual([]);
        const tooMuch = { outputs: [out(addrOf(KEY_B), 15_800_000n)], withdrawals: rewardMap(KEY_B, 6_000_000n) };
        expect(run(tooMuch).failures.some((f) => f.startsWith("WithdrawalAmountsExceedingOriginalBalance"))).toBe(true);
        // the same partial withdrawal in Conway is ConwayIncompleteWithdrawals (pv 11)
        const conway = run(partial, { era: 7, params: { ...params, protocolMajor: 11 } });
        expect(conway.failures.some((f) => f.startsWith("ConwayIncompleteWithdrawals"))).toBe(true);
    });
    test("direct deposits need a registered account on this network", () => {
        const body = { outputs: [out(addrOf(KEY_B), 6_800_000n)], directDeposits: rewardMap(KEY_A, 3_000_000n) };
        expect(run(body).failures.some((f) => f.startsWith("DirectDepositAccountsMissing"))).toBe(true);
    });
    test("plutus legacy mode: any needed Plutus V1..V3 script", () => {
        expect(plutusLegacyMode(["h1"], new Map([["h1", 3]]))).toBe(true);
        expect(plutusLegacyMode(["h1"], new Map([["h1", 4]]))).toBe(false);
        expect(plutusLegacyMode([], new Map())).toBe(false);
    });
    test("required top-level guards must be top-level guards; guard datums follow the credential kind", () => {
        const cred = (t: number, h: string) => ({ type: t, hash: { toString: () => h } });
        const sink = { failures: [] as string[], reports: [] as string[] };
        checkDijkstraTx(sink, {
            body: { guards: [cred(0, KEY_A)], requiredTopLevelGuards: [{ credential: cred(0, KEY_A), data: null }], subTransactions: [{ body: { requiredTopLevelGuards: [{ credential: cred(0, KEY_B), data: null }] } }] },
            network: "mainnet", providedScripts: new Map(), legacyMode: false, strict: true,
        });
        expect(sink.failures.some((f) => f.startsWith("MissingRequiredGuards: 1 credential"))).toBe(true);
        const s2 = { failures: [] as string[], reports: [] as string[] };
        checkDijkstraTx(s2, { body: { guards: [cred(1, "11".repeat(28))], requiredTopLevelGuards: [{ credential: cred(1, "11".repeat(28)), data: null }] }, network: "mainnet", providedScripts: new Map([["11".repeat(28), { kind: "plutus" }]]), legacyMode: false, strict: true });
        expect(s2.failures.some((f) => f.startsWith("MalformedGuardDatums"))).toBe(true);
    });
    test("account balance intervals: the balance after the sub-transactions, the starting ones before", () => {
        const ra = fromHex("e1" + KEY_B);
        const interval = (lo: bigint | null, hi: bigint | null) => ({ contains: (b: bigint) => (lo == null || b >= lo) && (hi == null || b < hi), toJson: () => ({ lo, hi }) });
        const mk = (k: "accountBalanceIntervals" | "startingAccountBalanceIntervals", lo: bigint | null, hi: bigint | null) => ({ [k]: [{ rewardAccount: ra, interval: interval(lo, hi) }], subTransactions: [{ body: { withdrawals: rewardMap(KEY_B, 1_000_000n) } }] });
        const check = (body: any) => { const s = { failures: [] as string[], reports: [] as string[] }; checkDijkstraTx(s, { body, network: "mainnet", rewardBalances: new Map([[KEY_B, 5_000_000n]]), stakeRegistered: () => true, providedScripts: new Map(), legacyMode: false, strict: true }); return s.failures; };
        expect(check(mk("accountBalanceIntervals", 4_000_000n, 4_000_001n))).toEqual([]); // 5 - 1 after the sub-transaction
        expect(check(mk("accountBalanceIntervals", 5_000_000n, null)).some((f) => f.startsWith("BalancesOutsideAccountBalanceIntervals"))).toBe(true);
        expect(check(mk("startingAccountBalanceIntervals", 5_000_000n, null))).toEqual([]);
        expect(rewardBytesKey(fromHex("f1" + KEY_B))).toBe("01" + KEY_B);
    });
});

describe("Dijkstra block rules (bug 427)", () => {
    const hb = (major: number, leios: boolean) => ({ header: { body: { protocolVersion: { major }, leiosCertified: leios } } });
    const run = (b: any, pm: number | null = 12) => { const s = { failures: [] as string[], reports: [] as string[] }; checkDijkstraBlock(s, { block: b, protocolMajor: pm }); return s; };
    test("HeaderProtVerTooLow", () => {
        expect(run({ ...hb(11, false) }).failures.some((f) => f.startsWith("HeaderProtVerTooLow"))).toBe(true);
        expect(run({ ...hb(13, false) }).failures).toEqual([]); // no HeaderProtVerTooHigh in Dijkstra
    });
    test("Peras certificates are refused; the Leios flag must match the body", () => {
        expect(run({ ...hb(12, false), perasCertificate: new Uint8Array([1]) }).failures.some((f) => f.startsWith("PerasCertValidationFailed"))).toBe(true);
        expect(run({ ...hb(12, true), leiosCertificate: null }).failures.some((f) => f.includes("certified flag"))).toBe(true);
        const certified = run({ ...hb(12, true), leiosCertificate: { signers: new Uint8Array(1), signature: new Uint8Array(48) }, transactions: [{}] });
        expect(certified.failures.some((f) => f.startsWith("LeiosCertifiedBlockTransactions"))).toBe(true);
        expect(certified.reports.some((r) => r.includes("not verified"))).toBe(true);
    });
    test("auxiliary data bytes are sliced from the block transaction as carried", () => {
        const tx = fromHex(hexFile("cardano_ledger_golden_tx.hex"));
        const parts = (Cbor.parseLazy(tx) as any).array as Uint8Array[];
        const blockTx = new Uint8Array([0x84, ...parts[0]!, ...parts[1]!, ...parts[2]!, 0xf5]);
        const noAux = new Uint8Array([0x84, ...parts[0]!, ...parts[1]!, 0xf6, 0xf4]);
        const hdr = (Cbor.parseLazy(blockBytes) as any).array[0] as Uint8Array;
        const blk = new Uint8Array([0x82, ...hdr, 0x83, 0x82, ...noAux, ...blockTx, 0xf6, 0xf6]);
        const m = dijkstraBlockAuxDataBytes(blk)!;
        expect([...m.keys()]).toEqual([1]);
        expect(toHex(m.get(1)!)).toBe(toHex(parts[2]!));
        expect(m.get(1)![0]).toBe(0xd9); // tag 259 kept as carried
    });
    test("reference-script limits and price from the protocol parameters", () => {
        expect(dijkstraRefScriptParams({ max_ref_script_size_per_tx: 1000, ref_script_cost_stride: 100, ref_script_cost_multiplier: "3/2" })).toEqual({ maxPerTx: 1000, maxPerBlock: null, stride: 100, multiplier: { num: 3n, den: 2n } });
        expect(dijkstraRefScriptParams({ ref_script_cost_multiplier: 1.2 }).multiplier).toEqual({ num: 12n, den: 10n });
    });
});

describe("Dijkstra protocol parameters (bug 430)", () => {
    test("update keys 34..56 and the PlutusV4 cost model are decoded only for Dijkstra", () => {
        const upd = new CborMap([
            { k: new CborUInt(18), v: new CborMap([{ k: new CborUInt(3), v: new CborArray([new CborUInt(1), new CborUInt(2)]) }]) },
            { k: new CborUInt(37), v: Cbor.parse(fromHex("d81e820605")) },
            { k: new CborUInt(43), v: new CborUInt(900) },
            { k: new CborUInt(47), v: new CborArray([new CborUInt(10), new CborUInt(20)]) },
            { k: new CborUInt(53), v: new CborSimple(null) },
        ]);
        expect(paramChangesOfUpdateMap(upd)).toEqual({});
        expect(paramChangesOfUpdateMap(upd, { dijkstra: true })).toEqual({
            cost_models: { PlutusV4: [1, 2] }, ref_script_cost_multiplier: "6/5", leios_committee_size: 900, max_eb_ex_mem: "10", max_eb_ex_steps: "20", peras_bootstrap_round: null,
        });
    });
    test("musashi's Dijkstra genesis: the upgrade fields and a 251-entry PlutusV4 cost model", () => {
        const g = JSON.parse(readFileSync(FIX("musashi-dijkstra-genesis.json"), "utf8"));
        const raw = dijkstraGenesisRaw(g, { PlutusV3: [1] });
        expect(raw.max_ref_script_size_per_tx).toBe(204800);
        expect(raw.ref_script_cost_multiplier).toBe(1.2);
        expect(raw.min_pool_margin).toBe(0.015);
        expect((raw.cost_models as any).PlutusV4.length).toBe(251);
        expect((raw.cost_models as any).PlutusV3).toEqual([1]);
    });
    test("N2C PParams: 54 fields from protocol 12, Conway's 31 before", () => {
        const base = { protocol_major_ver: 12, min_fee_a: 44, min_fee_b: 155381, a0: 0.3, rho: 0.003, tau: 0.2, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15 };
        expect(dijkstraPParamsCbor(base).array.length).toBe(54);
        expect(pparamsCborFor(base).array.length).toBe(54);
        expect(pparamsCborFor({ ...base, protocol_major_ver: 11 }).array.length).toBe(31);
        const enc = dijkstraPParamsCbor({ ...base, peras_bootstrap_round: 7 }).array;
        expect((enc[50] as CborArray).array.length).toBe(1); // StrictMaybe → [x]
        expect((dijkstraPParamsCbor(base).array[50] as CborArray).array.length).toBe(0);
        expect(dijkstraPParamsCbor(base).array[35] instanceof CborSimple).toBe(true); // maxPledgeLeverage unset → null
    });
});

describe("Plutus V4 in the ledger rules (bug 433)", () => {
    const v4 = new CborBytes(new Uint8Array([0x43, 1, 2, 3]));
    const ws = Cbor.encode(new CborMap([{ k: new CborUInt(8), v: new CborArray([v4]) }])).toBuffer();
    test("witness key 8 and script tag 4 only from Dijkstra", () => {
        expect(witnessScriptHashes(ws).size).toBe(0);
        const h = witnessScriptHashes(ws, 4);
        expect(h.size).toBe(1);
        const [hash, w] = [...h][0]!;
        expect(w.language).toBe(4);
        expect(hash).toBe(toHex(require("@harmoniclabs/crypto").blake2b_224(new Uint8Array([4, 0x43, 1, 2, 3]))));
        const ref = Cbor.encode(new CborArray([new CborUInt(4), v4])).toBuffer();
        expect(scriptLanguageOfCbor(ref)).toBeNull();
        expect(scriptLanguageOfCbor(ref, 4)).toBe(4);
    });
    test("the V4 language view: key 3, the cost model as a definite list", () => {
        const view = languageViews({ 4: [1, 2] }, new Set([4]));
        expect(toHex(view!)).toBe("a103820102");
    });
});
