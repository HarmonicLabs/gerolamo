/**
 * Mempool rule fixes found with pragma-org's node-diversity-conformance `ledger-rules` corpus
 * (docs/parity/ndc-ledger-rules.md, bugs 530–533). Each test replays the corpus transaction (bytes
 * as published) against the state the fixture declares, built here by hand.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborSimple, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import { outputLike } from "../consensus/rules/blockRulesPure";
import type { EpochBodyParams } from "../consensus/epochParams";
import type { GovLedgerView } from "../consensus/governance/govRules";
import { getEpochNetwork, setEpochNetwork, EPOCH_GEOMETRY } from "../utils/epochFromSlotCalculations";
import { ValidatingMempool, type MempoolLedgerView } from "./ValidatingMempool";
import { ALL_INPUTS_SPENT } from "./applyTxErr";
import { forecastHorizonSlot, maxRefScriptSizePerTx, MAX_REF_SCRIPT_SIZE_PER_TX } from "./conwayMempoolRules";

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const raw = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", key_deposit: "2000000", pool_deposit: "500000000",
    coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "10", protocol_minor_ver: "0",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000",
    min_fee_ref_script_cost_per_byte: 15, e_max: 18, min_pool_cost: "340000000", gov_action_deposit: "100000000000", drep_deposit: "500000000", gov_action_lifetime: 6,
};
const params: EpochBodyParams = { epoch: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 10, raw };

/** An empty governance state: nothing registered. */
const emptyGov: GovLedgerView = {
    accountRegistered: () => false, accountDeposit: () => null, accountBalance: () => null, balancesExact: () => ({ exact: true, why: "" }), accountDRep: () => null,
    poolRegistered: () => false, poolVrf: () => null, registeredVrfs: () => null, drepRegistered: () => false, drepDeposit: () => null,
    committeeMembers: () => new Map(), committeeCreds: () => new Map(), proposals: () => new Map(),
    roots: () => ({ pparams: null, hardfork: null, committee: null, constitution: null }), constitutionScript: () => null, treasury: () => null,
};

/** The fixture's UTxO (`[input, output]` hex CBOR pairs), the ledger tip at slot −1 (the fixture point is slot 0). */
function view(utxo: Array<[string, string]>): MempoolLedgerView {
    const m = new Map<string, ResolvedUtxo>();
    for (const [i, o] of utxo) {
        const a = Cbor.parse(fromHex(i)) as CborArray;
        const ref = `${Buffer.from((a.array[0] as CborBytes).bytes).toString("hex")}:${Number((a.array[1] as CborUInt).num)}`;
        const x = outputLike(TxOut.fromCbor(fromHex(o)));
        m.set(ref, { ref, address: x.address, value: x.value, referenceScriptHash: x.referenceScriptHash ?? null, referenceScriptCbor: x.referenceScriptCbor ?? null, hasDatum: !!x.hasDatum, datumHash: x.datumHash ?? null, inlineDatumCbor: x.inlineDatumCbor ?? null });
    }
    return {
        tip: async () => ({ slot: -1n, hash: "00".repeat(32) }),
        state: async (slot) => ({ slot, params, genesis: null, network: "testnet" }),
        resolve: async (refs) => new Map(refs.filter((r) => m.has(r)).map((r) => [r, m.get(r)!])),
        pools: async () => new Set(),
        rewardBalances: async () => undefined,
        stake: async () => ({ registered: new Set(), delegated: new Map() }),
        epochNetwork: () => "preview",
        exactness: () => ({ exact: true, why: "" }),
        govLedgerView: async () => emptyGov,
    };
}

/** Walk a `ConwayLedgerPredFailure` down `path` (wire tags) and return the innermost failure. */
function dig(f: CborObj, path: number[]): CborArray | null {
    let o: CborObj | undefined = f;
    for (const t of path) {
        if (!(o instanceof CborArray) || !(o.array[0] instanceof CborUInt) || Number(o.array[0].num) !== t) return null;
        o = o.array[1];
    }
    return o instanceof CborArray ? o : null;
}
const tagOf = (o: CborObj | null | undefined) => (o instanceof CborArray && o.array[0] instanceof CborUInt ? Number(o.array[0].num) : null);
/** UTXO failures (LEDGER 1 ▸ UTXOW 0 ▸ …) and UTXOW failures of a rejection. */
const utxoFailures = (fs: readonly CborObj[]) => fs.map((f) => dig(f, [1, 0])).filter((x): x is CborArray => !!x);
const utxowFailures = (fs: readonly CborObj[]) => fs.map((f) => (tagOf(f) === 1 ? (f as CborArray).array[1] : null)).filter((x): x is CborArray => x instanceof CborArray);

// ── corpus transactions (node-diversity-conformance scenarios/ledger-rules, fixture id in the name)

/** 00200: marked invalid, no Plutus script at all. */
const TX_00200 = "84a400d90102818258200356f27908a57b5c3bbb0f3aa690cca11b2a3d4c0c864b17b142b39693ee3641000181a200581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a0049c9eb021a000281550f00a100d90102818258202152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db125840668f6dbae99b4a48b689a370b4ce0897cf8b846e5c40db32fdc4540568050d7366c3fccb4c74b37667364dcaf26f2bf93a05b41228ec6467176658333e01340cf4f6";
const UTXO_00200: Array<[string, string]> = [["8258200356f27908a57b5c3bbb0f3aa690cca11b2a3d4c0c864b17b142b39693ee364100", "a200581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a004c4b40"]];

/** 00274: marked invalid (its V3 script fails), registers a stake credential delegated to an unregistered pool. */
const TX_00274 = "84a700d901028182582068f207a1a50bedbfc0be901465804bc93e44d244199a21f62eabb7d0076ac9ed000181a200581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a0029f630021a0003d09004d9010281840b8200581c93c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8581c154512108969d53b4535459ff8581ad35072082bdc4b66550d3584131a001e84800b58200ddcceb08dbb394c29ef7fa4c16f8e738daf1333cafe4d28ba9e0f67aeaf97bb0dd901028182582039ffac0ab0b6e411a585938da683f01d4165ef1bbcda4489e194ef31ce29beb0000f00a300d90102818258202152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12584030533f60dee47e8fba3058405e347c68d31a143fd2934ef550a0211e7e3ec9a99d37f719c77ff6e13bca060a972e9e744c1439a6675db19d2ecea76db4bde90205a18200008200821907d01a000f424007d9010281454401010061f4f6";
const UTXO_00274: Array<[string, string]> = [
    ["82582068f207a1a50bedbfc0be901465804bc93e44d244199a21f62eabb7d0076ac9ed00", "a200581d70994b345acef955ada938b01e9f0405ab57743d41f0b398de604d0969011a004c4b40"],
    ["82582039ffac0ab0b6e411a585938da683f01d4165ef1bbcda4489e194ef31ce29beb000", "a200581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a002dc6c0"],
];

/** 00088: a Plutus V3 spend with validity upper bound slot 500 000, applied at slot 0. */
const TX_00088 = "84bf00d90102818258201111111111111111111111111111111111111111111111111111111111111111000181bf00581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a00958940ff021a00030d40031a0007a1200b58200ddcceb08dbb394c29ef7fa4c16f8e738daf1333cafe4d28ba9e0f67aeaf97bb0dd9010281825820222222222222222222222222222222222222222222222222222222222222222200ffa300d90102818258202152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db125840f2702a3015e6f65352819a0017599550b7471b153b0fd46a1b8685fc164b1e2a82892a000e5443eb0bfb97d3ef0a8b950f8a72f905427ec254a6333a85e0020907d901028145440101006105a18200008200821907d01a000f4240f5f6";
const UTXO_00088: Array<[string, string]> = [
    ["825820111111111111111111111111111111111111111111111111111111111111111100", "bf00581d70994b345acef955ada938b01e9f0405ab57743d41f0b398de604d0969011a00989680ff"],
    ["825820222222222222222222222222222222222222222222222222222222222222222200", "bf00581d6093c191b1094746961f6f00fba27f3d8eff6a66490baf806d4e179fd8011a004c4b40ff"],
];

/** 00079: spends a Byron output; its bootstrap witness carries the right key, chain code and attributes, a wrong signature. */
const TX_00079 = "84a400d9010281825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000181a200581d60c3f9920656fdbfe2842e2c5671e0a2b0c1c84c497d42879de5376d7b011a00493e00021a00030d400f00a102d9010281845820d59ec5ed32f67079f20d0e0d4146d7f19db515836adeb3956a739b62ff9d489f5840e232bc6acf5af5cee10af8224d5b0b18990239589b00885309efabe5af47ff659fe5bae54991f7ba6fea0c32a445bbf52aaf47b6387e849e51ee150468855d085820b3db22d54df4d54b96cb2cf7c731d643559cd7ddf351943de2e417aef2069d815825a201581e581c66e1b3a99eb32c018ee2ffb3de7a95f38cbb131e29701348138511e0024101f5f6";
const UTXO_00079: Array<[string, string]> = [["825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00", "a200584f82d818584583581c65b1fe57f0ed455254aacf1486c448d7f34038c4c445fa905de33d8ea201581e581c66e1b3a99eb32c018ee2ffb3de7a95f38cbb131e29701348138511e0024101001a2e1ee14c011a004c4b40"]];

const prevNet = getEpochNetwork();
afterEach(() => { setEpochNetwork(prevNet); });

describe("node-diversity-conformance ledger-rules fixes", () => {
    test("bug 530: marked invalid with every script passing (here: none) is ValidationTagMismatch False PassedUnexpectedly", async () => {
        const mp = new ValidatingMempool({ view: view(UTXO_00200), rejectFailedPlutus: true, rejectUncheckedPlutus: true });
        const r = await mp.addTx(fromHex(TX_00200));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const utxos = utxoFailures(r.failures).map((f) => dig(f, [0])).filter(Boolean) as CborArray[];
        expect(utxos.length).toBe(1);
        // [0 ValidationTagMismatch, False, [0 PassedUnexpectedly]]
        expect(Buffer.from(Cbor.encode(utxos[0]!).toBuffer()).toString("hex")).toBe("83" + "00" + "f4" + "8100");
        expect((utxos[0]!.array[1] as CborSimple).simple).toBe(false);
    });

    test("bug 531: a transaction marked invalid skips CERTS and GOV (its delegation to an unknown pool does not count)", async () => {
        const mp = new ValidatingMempool({ view: view(UTXO_00274), rejectFailedPlutus: false, rejectUncheckedPlutus: false });
        const r = await mp.addTx(fromHex(TX_00274));
        expect(r.ok).toBe(true);
    });

    test("bug 531: a transaction marked invalid spends its collateral, not its inputs, for the next mempool transaction", async () => {
        const mp = new ValidatingMempool({ view: view(UTXO_00274), rejectFailedPlutus: false, rejectUncheckedPlutus: false });
        expect((await mp.addTx(fromHex(TX_00274))).ok).toBe(true);
        // Resubmitted, its spending input is still unspent (no "all inputs spent"), its collateral is gone (BadInputsUTxO).
        const again = await mp.addTx(fromHex(TX_00274));
        expect(again.ok).toBe(false);
        if (again.ok) return;
        expect(again.reasons.join(" ")).not.toContain("already included");
        expect(again.failures.some((f) => f instanceof CborArray && (f.array[1] as any)?.text === ALL_INPUTS_SPENT)).toBe(false);
        expect(utxoFailures(again.failures).map(tagOf)).toContain(1);
    });

    test("bug 532: forecast horizon is the first epoch boundary at or after next(tip) + stability window", () => {
        const g = { systemStartUnix: 0n, byronSlotsPerEpoch: 432_000n, shelleyStartSlot: 0n, shelleyStartEpoch: 0n, shelleySlotsPerEpoch: 432_000n, stabilityWindow: 129_600n };
        expect(forecastHorizonSlot(0n, g)).toBe(432_000n);
        expect(forecastHorizonSlot(302_400n, g)).toBe(432_000n);
        expect(forecastHorizonSlot(302_401n, g)).toBe(864_000n);
        expect(forecastHorizonSlot(0n, { ...g, stabilityWindow: undefined })).toBeNull();
        expect(forecastHorizonSlot(100n, EPOCH_GEOMETRY.preview)).toBe(86_400n);
    });

    test("bug 532: a Plutus transaction whose upper bound is past the forecast horizon fails OutsideForecast", async () => {
        setEpochNetwork("preview"); // horizon from slot 0: 86 400 (the corpus's preprod-like era: 432 000); the bound is 500 000
        const mp = new ValidatingMempool({ view: view(UTXO_00088), rejectFailedPlutus: true, rejectUncheckedPlutus: true });
        const r = await mp.addTx(fromHex(TX_00088));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const f = utxoFailures(r.failures).find((x) => tagOf(x) === 17);
        expect(f).toBeDefined();
        expect((f!.array[1] as CborUInt).num).toBe(500_000n);
    });

    test("bug 532 (parameter): the per-transaction reference-script limit is Conway's constant unless the record carries one", () => {
        expect(maxRefScriptSizePerTx({})).toBe(MAX_REF_SCRIPT_SIZE_PER_TX);
        expect(maxRefScriptSizePerTx({ max_ref_script_size_per_tx: 50 })).toBe(50);
        expect(maxRefScriptSizePerTx({ max_ref_script_size_per_tx: "204800" })).toBe(204_800);
    });

    test("bug 533: a bootstrap witness with a bad signature is InvalidWitnessesUTXOW (its vkey), not a missing witness", async () => {
        const mp = new ValidatingMempool({ view: view(UTXO_00079), rejectFailedPlutus: true, rejectUncheckedPlutus: true });
        const r = await mp.addTx(fromHex(TX_00079));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const utxow = utxowFailures(r.failures);
        const invalid = utxow.find((x) => tagOf(x) === 1);
        expect(invalid).toBeDefined();
        const vkeys = (invalid!.array[1] as CborArray).array.map((b) => Buffer.from((b as CborBytes).bytes).toString("hex"));
        expect(vkeys).toEqual(["d59ec5ed32f67079f20d0e0d4146d7f19db515836adeb3956a739b62ff9d489f"]);
        expect(utxow.some((x) => tagOf(x) === 2)).toBe(false); // MissingVKeyWitnessesUTXOW
    });
});
