/**
 * Bug 304: the genesis ledger state of each network (what cardano-node's initial ExtLedgerState
 * holds) and an LMDB store that starts empty, anchored at the origin.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { triggersFrom } from "../consensus/hfc/HardForkHistory";
import { byronLedgerConfigFromGenesis, encodeByronLedgerCore, initialByronLedgerState } from "../consensus/byron/ByronLedger";
import chain from "../consensus/byron/__fixtures__/preprod-byron-chain.json";
import { LedgerStore } from "./LedgerStore";
import { StakeReads, StakeWrites } from "./stakeStore";
import { UtxoReads, UtxoWrites } from "./utxoStore";
import { AVVM_STASH_DB, buildGenesisLedgerState, readGenesisMeta, returnStashedAvvm, startEraAtGenesis, translateByronUtxoAtShelleyStart, utxoTotals, writeGenesisLedgerState, type GenesisInputs } from "./genesisState";
import { configureLedgerStore, getLedgerStore, ledgerAfterRange, ledgerBeginBlock, ledgerCommitBlock, ledgerStateExact, ledgerStoreBroken, openNodeLedgerStore } from "./nodeLedgerStore";
import { initSql } from "../sql";

const root = mkdtempSync(join(tmpdir(), "gerolamo-genesis-state-"));
afterAll(() => { getLedgerStore()?.close(); configureLedgerStore("sqlite"); delete process.env.GEROLAMO_GENESIS_EXACT; rmSync(root, { recursive: true, force: true }); });
const cfgDir = (n: string) => join(import.meta.dir, "..", "config", n);
const json = (n: string, f: string) => JSON.parse(readFileSync(join(cfgDir(n), f), "utf8"));
const config = (n: string) => json(n, "config.json");
function inputs(n: "preview" | "preprod" | "mainnet"): GenesisInputs {
    const c = config(n);
    return {
        network: n, networkMagic: Number(c.networkMagic ?? (n === "mainnet" ? 764824073 : 0)),
        byron: json(n, "byron-genesis.json"), shelley: json(n, "shelley-genesis.json"), alonzo: json(n, "alonzo-genesis.json"), conway: json(n, "conway-genesis.json"),
        triggers: triggersFrom({}, n), byronGenesisHash: c.byronGenesisHash, shelleyGenesisHash: c.shelleyGenesisHash, shelleyGenesisBytes: readFileSync(join(cfgDir(n), "shelley-genesis.json")),
    };
}
const MAX = 45_000_000_000_000_000n;

describe("genesis ledger state per network", () => {
    test("preview starts in Alonzo: Byron genesis translated (zero outputs dropped), reserves = max supply − UTxO", async () => {
        const g = await buildGenesisLedgerState(inputs("preview"));
        expect(startEraAtGenesis(triggersFrom({}, "preview"))).toBe(4);
        expect(g.startEra).toBe(4);
        expect(g.firstPrevHash).toBeNull(); // the first block (slot 0) names no parent
        expect(g.zeroOutputs).toBe(7); // the seven zero-balance genesis delegate addresses
        expect(g.utxos.map((u) => u.utxo_ref)).toEqual(["4843cf2e582b2f9ce37600e5ab4cc678991f988f8780fed05407f9537f7712bd:0"]); // spent at slot 60
        expect(g.utxoTotal).toBe(30_000_000_000_000_000n);
        expect(g.reserves).toBe(MAX - 30_000_000_000_000_000n); // Koios epoch 1: reserves 14 991 000 000 000 000 after the first 9e12 to the treasury
        expect(g.genDelegs).toHaveLength(7);
        expect(g.byronRecord).toBeNull();
        expect(g.pools).toEqual([]);
        expect(g.shelleyGenesisHash).toBe(config("preview").shelleyGenesisHash); // the file in the repository hashes to the configured initial nonce
        expect(g.warnings).toEqual([]);
    });
    test("preprod starts in Byron: every genesis balance (zeros included), the Byron record, the genesis hash as the first parent", async () => {
        const g = await buildGenesisLedgerState(inputs("preprod"));
        expect(g.startEra).toBe(0);
        expect(g.firstPrevHash).toBe("d4b8de7a11d929a323373cbab6c1a9bdc931beffff11db111cf9d57356ee1937");
        expect(chain.blocks[0]!.hex).toContain(g.firstPrevHash!); // the first EBB's prev hash
        expect(g.utxos).toHaveLength(8);
        expect(g.utxos.filter((u) => u.lovelace === "0")).toHaveLength(7);
        expect(g.utxos.find((u) => u.lovelace !== "0")!.utxo_ref).toBe("5526b1373acfc774794a62122f95583ff17febb2ca8a0fe948d097e29cf99099:0");
        expect(g.reserves).toBeNull(); // the Shelley translation (epoch 4) sets the pots
        expect(g.byronRecord!.core).toBe(encodeByronLedgerCore(initialByronLedgerState(byronLedgerConfigFromGenesis(json("preprod", "byron-genesis.json")))));
        expect(g.byronRecord!.tip).toBe("0|");
        expect(g.shelleyGenesisHash).toBe(config("preprod").shelleyGenesisHash);
    });
    test("mainnet starts in Byron with the 14 505 AVVM outputs", async () => {
        const g = await buildGenesisLedgerState(inputs("mainnet"));
        expect(g.startEra).toBe(0);
        expect(g.firstPrevHash).toBe("5f20df933584822601f9e3f8c024eb5eb252fe8cefb24d1317dc3d432e940ebb");
        expect(g.utxos).toHaveLength(14_505);
        expect(g.utxoTotal).toBe(31_112_484_745_000_000n);
        expect(g.utxos.some((u) => u.utxo_ref === "8ee33c9906974706223d7d500d63bbee2369d7150f972757a9fdded2f706b938:0")).toBe(true);
    });
    test("a Shelley-at-0 custom network: initial funds and genesis staking are injected; mainnet refuses them", async () => {
        const addr = "60" + "11".repeat(28); // enterprise key-hash address, testnet
        const shelley = { ...json("preview", "shelley-genesis.json"), initialFunds: { [addr]: 1_000_000_000 }, staking: {
            pools: { ["aa".repeat(28)]: { publicKey: "aa".repeat(28), vrf: "bb".repeat(32), pledge: 5, cost: 340000000, margin: 0.025, rewardAccount: { network: "Testnet", credential: { keyHash: "cc".repeat(28) } }, owners: ["cc".repeat(28)], relays: [], metadata: null } },
            stake: { ["cc".repeat(28)]: "aa".repeat(28), ["dd".repeat(28)]: "aa".repeat(28) },
        } };
        const inp: GenesisInputs = { network: "custom", networkMagic: 42, byron: null, shelley, triggers: triggersFrom({ TestShelleyHardForkAtEpoch: 0, TestAllegraHardForkAtEpoch: 0 }, "custom"), shelleyGenesisHash: null };
        const g = await buildGenesisLedgerState(inp);
        expect(g.startEra).toBe(2);
        const txId = Buffer.from(blake2b_256(fromHex(addr))).toString("hex"); // initialFundsPseudoTxIn
        expect(g.utxos.map((u) => u.utxo_ref)).toEqual([`${txId}:0`]);
        expect(g.utxos[0]!.lovelace).toBe("1000000000");
        expect(g.reserves).toBe(MAX - 1_000_000_000n);
        expect(g.pools).toEqual([{ poolId: "aa".repeat(28), vrf: "bb".repeat(32), params: { pledge: "5", cost: "340000000", marginNum: "1", marginDen: "40", rewardAccount: "cc".repeat(28), owners: ["cc".repeat(28)] } }]);
        expect(g.accounts.map((a) => [a.cred.slice(0, 2), a.ptr])).toEqual([["cc", [0, 0, 0]], ["dd", [0, 0, 1]]]);
        await expect(buildGenesisLedgerState({ ...inp, networkMagic: 764824073 })).rejects.toThrow("protectMainnet");
        await expect(buildGenesisLedgerState({ ...inp, shelley: { ...shelley, staking: { pools: {}, stake: { ["cc".repeat(28)]: "ee".repeat(28) } } } })).rejects.toThrow("unregistered stake pool");
    });
    test("a Byron-first chain needs the genesis hash", async () => {
        await expect(buildGenesisLedgerState({ ...inputs("preprod"), byronGenesisHash: null })).rejects.toThrow("Byron genesis hash");
    });
});

describe("writing the genesis state into an empty store", () => {
    test("preview: UTxO, genesis delegations, pots; refused on a store that is not empty", async () => {
        const st = LedgerStore.open(join(root, "preview"), { persistDiffs: false });
        const g = await buildGenesisLedgerState(inputs("preview"));
        const meta = await writeGenesisLedgerState(st, g);
        expect(meta).toMatchObject({ network: "preview", startEra: 4, firstPrevHash: null, utxos: 1, utxoTotal: "30000000000000000", reserves: "15000000000000000" });
        expect(readGenesisMeta(st)?.startEra).toBe(4);
        expect(new UtxoReads(st).count()).toBe(1);
        const s = new StakeReads(st);
        expect(s.pots()).toEqual({ reserves: 15_000_000_000_000_000n, treasury: 0n, feePot: 0n, donationPot: 0n, initializedEpoch: 0 });
        expect(s.genesisDelegsAt(0).size).toBe(7);
        expect(st.anchor()).toBeNull(); // the origin
        await expect(writeGenesisLedgerState(st, g)).rejects.toThrow("already holds a genesis state");
        st.close();
    });
    test("preprod: the eight Byron outputs (zero balances too) and the Byron chain-validation record", async () => {
        const st = LedgerStore.open(join(root, "preprod"), { persistDiffs: false });
        await writeGenesisLedgerState(st, await buildGenesisLedgerState(inputs("preprod")));
        expect(utxoTotals(st)).toEqual({ count: 8, lovelace: 30_000_000_000_000_000n });
        expect(new StakeReads(st).pots()).toBeNull();
        expect(new TextDecoder().decode(st.get("byron", new TextEncoder().encode("tip")))).toBe("0|");
        st.close();
    });
});

describe("era translations of a Byron-first store", () => {
    test("Shelley start drops zero-value outputs and stashes AVVM outputs; Allegra returns the unspent ones to the reserves", async () => {
        const st = LedgerStore.open(join(root, "translate"), { persistDiffs: false });
        const u = new UtxoWrites(st), w = new StakeWrites(st);
        const avvm = "Ae2tdPwUPEZHFQnrr2dYB4GEQ8WVKspEyrg29pJ3f7qdjzaxjeShEEokF5f", avvm2 = "Ae2tdPwUPEZFF5MA48FeLbPhKPbC9pG5DpzReXzzoFhofPR7nZQ8DSR3A4G";
        const plain = "FHnt4NL7yPXuYUxBF33VX5dZMBDAab2kvSNLRzCskvuKNCSDknzrQvKeQhGUw5a";
        const rec = (ref: string, address: string, lovelace: string) => ({ utxo_ref: ref, tx_out: JSON.stringify({ address, amount: lovelace, assets: {} }), tx_hash: ref.slice(0, 64), address, lovelace, reference_script_hash: null, stake_key: null });
        st.applyDirectSync(() => {
            u.put(rec(`${"01".repeat(32)}:0`, plain, "0"));
            u.put(rec(`${"02".repeat(32)}:0`, plain, "5"));
            u.put(rec(`${"03".repeat(32)}:0`, avvm, "1000"));
            u.put(rec(`${"04".repeat(32)}:0`, avvm2, "2000"));
        });
        const h = (n: number) => new Uint8Array(32).fill(n);
        st.beginBlock(h(1), null, 100);
        const r = translateByronUtxoAtShelleyStart(st);
        w.initPots(4, MAX - 3005n);
        st.commitBlock(false);
        expect(r).toEqual({ zeroDropped: 1, avvmStashed: 2, avvmLovelace: 3000n });
        expect(utxoTotals(st)).toEqual({ count: 3, lovelace: 3005n });
        st.beginBlock(h(2), h(1), 200); u.del([`${"04".repeat(32)}:0`]); st.commitBlock(false); // one redeemed before Allegra
        st.beginBlock(h(3), h(2), 300);
        expect(returnStashedAvvm(st)).toEqual({ returned: 1, lovelace: 1000n });
        expect(returnStashedAvvm(st)).toEqual({ returned: 0, lovelace: 0n }); // the stash is empty now
        st.commitBlock(false);
        expect(new StakeReads(st).pots()!.reserves).toBe(MAX - 3005n + 1000n);
        expect(utxoTotals(st)).toEqual({ count: 1, lovelace: 5n });
        expect([...st.range(AVVM_STASH_DB, new Uint8Array(0))]).toHaveLength(0);
        st.close();
    });
});

describe("a node store from genesis (lmdb mode)", () => {
    test("built on an empty chain, the first block's parent is the Byron genesis hash, promotion anchors it, a restart finds the chain", async () => {
        // the node takes the eras from its hard-fork history (installed from the config at startup); other test
        // files leave a preview history and network behind in this process
        const { setHardForkHistory } = await import("../consensus/hfc/hfcNode");
        const { setEpochNetwork } = await import("../utils/epochFromSlotCalculations");
        setHardForkHistory(null);
        setEpochNetwork("preprod");
        initSql(join(root, "node.db"));
        const c = config("preprod");
        const base = { dbPath: join(root, "node.db"), ledgerDir: join(root, "node-ledger"), ledgerStore: "lmdb", syncFromGenesis: true, networkMagic: 1,
            byronGenesisFile: join(cfgDir("preprod"), "byron-genesis.json"), shelleyGenesisFile: join(cfgDir("preprod"), "shelley-genesis.json"), byronGenesisHash: c.byronGenesisHash, shelleyGenesisHash: c.shelleyGenesisHash };
        expect(await openNodeLedgerStore({ ...base, syncFromGenesis: false }, null)).not.toBeNull(); // no syncFromGenesis: stays empty (a snapshot import comes)
        expect(readGenesisMeta(getLedgerStore()!)).toBeNull();
        getLedgerStore()!.close();
        await openNodeLedgerStore(base, null);
        const st = getLedgerStore()!;
        expect(readGenesisMeta(st)?.firstPrevHash).toBe(c.byronGenesisHash);
        expect(ledgerStateExact()).toEqual({ exact: false, why: expect.stringContaining("synced from genesis") });
        process.env.GEROLAMO_GENESIS_EXACT = "1";
        const { markLedgerSource } = await import("./nodeLedgerStore");
        await markLedgerSource(st, "genesis"); // drops the memo
        expect(ledgerStateExact().exact).toBe(true);
        delete process.env.GEROLAMO_GENESIS_EXACT;
        await markLedgerSource(st, "genesis");
        const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; x[1] = 0x9e; return x; };
        // block 0's parent is the genesis hash (bug 304: this marked the store broken)
        ledgerBeginBlock(h(0), fromHex(c.byronGenesisHash), 0); ledgerCommitBlock();
        for (let i = 1; i < 12; i++) { ledgerBeginBlock(h(i), h(i - 1), i * 10); ledgerCommitBlock(); }
        await ledgerAfterRange(20); // nothing deep enough: still at the origin
        expect(ledgerStoreBroken()).toBeNull();
        expect(st.anchor()).toBeNull();
        expect(st.chainReachesAnchor(h(11))).toBe(true);
        await ledgerAfterRange(5);
        expect(st.anchor()?.slot).toBe(60);
        expect(new UtxoReads(st).count()).toBe(8);
        st.close();
        // restart at the selected tip: the anchor and the diffs reach it
        await openNodeLedgerStore(base, { slot: 110, hash: h(11) });
        expect(getLedgerStore()!.anchor()?.slot).toBe(60);
        expect(getLedgerStore()!.volatileCount()).toBe(5);
        getLedgerStore()!.close();
    });
    test("a restart before the first promotion finds the chain through the diffs from the origin; a lost tip is refused with the remedy", async () => {
        const c = config("preview");
        const base = { dbPath: join(root, "node2.db"), ledgerDir: join(root, "node2-ledger"), ledgerStore: "lmdb", syncFromGenesis: true, networkMagic: 2,
            shelleyGenesisFile: join(cfgDir("preview"), "shelley-genesis.json"), byronGenesisFile: join(cfgDir("preview"), "byron-genesis.json"), byronGenesisHash: c.byronGenesisHash, shelleyGenesisHash: c.shelleyGenesisHash };
        const { setEpochNetwork } = await import("../utils/epochFromSlotCalculations");
        const { setHardForkHistory } = await import("../consensus/hfc/hfcNode");
        setHardForkHistory(null);
        setEpochNetwork("preview");
        await openNodeLedgerStore(base, null);
        const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; x[1] = 0x77; return x; };
        ledgerBeginBlock(h(0), null, 0); ledgerCommitBlock();
        ledgerBeginBlock(h(1), h(0), 20); ledgerCommitBlock();
        await ledgerAfterRange(432);
        expect(ledgerStoreBroken()).toBeNull();
        getLedgerStore()!.close();
        await openNodeLedgerStore(base, { slot: 20, hash: h(1) });
        expect(getLedgerStore()!.volatileCount()).toBe(2);
        expect(new StakeReads(getLedgerStore()!).pots()?.reserves).toBe(15_000_000_000_000_000n);
        getLedgerStore()!.close();
        await expect(openNodeLedgerStore(base, { slot: 40, hash: h(9) })).rejects.toThrow("first k blocks from genesis");
        getLedgerStore()?.close();
        setEpochNetwork("preprod");
    });
});
