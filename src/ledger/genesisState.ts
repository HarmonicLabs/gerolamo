/**
 * The ledger state at genesis (bug 304): what cardano-node's initial `ExtLedgerState` holds before
 * the first block, built from the network's genesis files and written into an EMPTY LMDB ledger
 * store, which then stands at the origin (no anchor; the first block's diff extends it).
 *
 * What cardano-node does (ouroboros-consensus-cardano `protocolInfoCardano` /
 * `mkInitExtLedgerStateCardano`; cardano-ledger-conway-1.22.1.0):
 *   1. Byron's initial `ChainValidationState`: `genesisUtxo` — one output per `avvmDistr` /
 *      `nonAvvmBalances` entry at `TxIn (blake2b-256 (address bytes)) 0`, zero balances INCLUDED
 *      (`UTxO.fromBalances`, no filter) — the initial update state and the genesis heavy delegation.
 *   2. `injectInitialExtLedgerState` extends the telescope to slot 0: every era whose
 *      `Test*HardForkAtEpoch` is 0 is entered by translation (no tick), Byron → Shelley via
 *      `translateToShelleyLedgerState`: the Byron UTxO translated WITHOUT its zero-value outputs
 *      ("we do not allow zero values in TxOuts in Shelley onwards"), reserves = maxLovelaceSupply −
 *      Σ UTxO, treasury 0, deposits/fees 0, empty snapshots, empty pool distribution, `esNonMyopic`
 *      = def (empty), the Shelley genesis `genDelegs`, the genesis protocol parameters, and the
 *      redeem (AVVM) outputs stashed; Shelley → Allegra returns the stashed AVVM outputs still
 *      unspent to the reserves (`translateEra` Allegra); the other translations change parameters
 *      only (Alonzo / Conway genesis, merged by `applyEraGenesis` at the first boundary).
 *   3. `perEraInjections`: `injectIntoTestState` of the era the state is in — Shelley…Babbage
 *      `shelleyRegisterInitialFundsThenStaking` (initial funds at `TxIn (blake2b-256 addr) 0`
 *      with reserves reduced by them; genesis staking pools; stake credentials registered with
 *      pointer `Ptr 0 (i div 2^16) (i mod 2^16)` and delegated; the mark snapshot and `nesPd` from
 *      the instant stake), Alonzo+ also the `extraConfig` cost models, Conway also `initialDReps` /
 *      `delegs`. Mainnet refuses any of it (`protectMainnet`); none of the three public networks
 *      carries initial funds, staking, extra cost models, initial DReps or Conway delegations.
 *   4. The Praos chain-dependent state starts at the TPraos initial nonce = the Shelley genesis
 *      hash (η0 = ηv = ηc, ηh neutral) — handled by the nonce evolver (`getEpochNonce` takes the
 *      configured `shelleyGenesisHash` for the Shelley start epoch), not stored here.
 *
 * Here: Byron-first networks (preprod, mainnet) get the Byron genesis UTxO (zero entries included)
 * and the Byron chain-validation record; the Shelley translation happens at the first Shelley
 * boundary (`translateByronUtxoAtShelleyStart`, called where the pots are initialised) and the
 * AVVM return at the Allegra boundary (`returnStashedAvvm`). Networks whose Shelley starts at
 * epoch 0 (preview) get the translated, injected state directly, pots included. The stake
 * snapshot taken by the first boundary (`takeStakeSnapshot`, inside the first block's diff, on the
 * genesis state) is `resetStakeDistribution`'s mark. The NonMyopic state, parameters and nonces
 * are written by the existing boundary code (`runEpochRewards`, `deriveLocalParams`, the evolver).
 *
 * Meta: `genesis` (JSON: network, start era, first block's parent, file hashes, totals) and
 * `ledger_source` = "genesis". Such a store is NOT exact until proven (see `ledgerStateExact`).
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { byronAddressType } from "../consensus/byron/byronAddressCompat";
import type { LedgerStore, LedgerView } from "./LedgerStore";
import { UtxoWrites, DB_UTXO, decodeRow, keyRef, refKey, type UtxoRecord } from "./utxoStore";
import { StakeWrites } from "./stakeStore";
import { BYRON_DB } from "./byronStore";
import { byronGenesisUtxoId, avvmGenesisAddress } from "../consensus/byron/genesisUtxo";
import { byronLedgerConfigFromGenesis, encodeByronLedgerCore, encodeByronLedgerTip, initialByronLedgerState } from "../consensus/byron/ByronLedger";
import { rationalFromDecimal } from "../consensus/rules/overlay";
import type { EraTrigger } from "../consensus/hfc/HardForkHistory";

const enc = new TextEncoder(), dec = new TextDecoder();
export const GENESIS_META_KEY = enc.encode("genesis");
/** Redeem (AVVM) outputs stashed at the Byron→Shelley translation, returned to the reserves at Allegra: ref key → empty. */
export const AVVM_STASH_DB = "avvm_stash";
const MAINNET_MAGIC = 764824073;

export interface GenesisInputs {
    /** Network name (preview / preprod / mainnet / a custom name): logs and the meta record only. */
    network: string;
    networkMagic: number;
    byron: any | null;
    shelley: any;
    alonzo?: any | null;
    conway?: any | null;
    /** The hard-fork triggers (HardForkHistory.triggers): which eras start at epoch 0. */
    triggers: readonly EraTrigger[];
    /** Configured genesis hashes (cardano-node config `ByronGenesisHash` / `ShelleyGenesisHash`). */
    byronGenesisHash?: string | null;
    shelleyGenesisHash?: string | null;
    /** The Shelley genesis file's bytes, to check `shelleyGenesisHash` (blake2b-256 of the file). */
    shelleyGenesisBytes?: Uint8Array | null;
}

export interface GenesisPool { poolId: string; vrf: string; params: { pledge: string; cost: string; marginNum: string; marginDen: string; rewardAccount: string; owners: string[] } }
export interface GenesisAccount { cred: string; pool: string; ptr: [number, number, number] | null }

export interface GenesisLedgerState {
    network: string;
    /** HFC era index the chain is in at slot 0 (0 Byron, 1 Shelley … 6 Conway). */
    startEra: number;
    /** The first block's parent: the Byron genesis hash (a Byron-first chain's first EBB), or null (Shelley-based genesis). */
    firstPrevHash: string | null;
    utxos: UtxoRecord[];
    utxoTotal: bigint;
    /** Byron genesis outputs with a zero balance: kept in Byron, dropped by the Shelley translation. */
    zeroOutputs: number;
    /** AVVM balance moved back to the reserves by an Allegra translation at genesis. */
    avvmReturned: bigint;
    genDelegs: Array<{ genesisKeyHash: string; delegate: string; vrf: string }>;
    /** Shelley-based genesis only: the translated account state (treasury 0). */
    reserves: bigint | null;
    pools: GenesisPool[];
    accounts: GenesisAccount[];
    /** Byron-first chains: the initial chain-validation record (update + heavy delegation). */
    byronRecord: { core: string; tip: string } | null;
    shelleyGenesisHash: string | null;
    byronGenesisHash: string | null;
    warnings: string[];
}

/** The era the telescope is in at slot 0: every consecutive era from Shelley whose trigger is epoch 0. */
export function startEraAtGenesis(triggers: readonly EraTrigger[]): number {
    let era = 0;
    for (let i = 1; i < triggers.length; i++) {
        const t = triggers[i]!;
        if (t.kind === "epoch" && t.epoch === 0n) era = i; else break;
    }
    return era;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const typedCred = (c: any): string => {
    const kh = c?.keyHash ?? c?.["key hash"], sh = c?.scriptHash ?? c?.["script hash"];
    if (typeof kh === "string") return kh.toLowerCase();
    if (typeof sh === "string") return `01${sh.toLowerCase()}`;
    throw new Error(`genesis staking: unreadable credential ${JSON.stringify(c)}`);
};

/** Byron's `genesisUtxo` as UTxO records (the same record form the SQLite seed and the importer write). */
function byronGenesisRecords(byron: any): UtxoRecord[] {
    const out: UtxoRecord[] = [];
    // `genesisUtxo`: avvmBalances <> nonAvvmBalances, every entry (zero balances too)
    const add = (address: string, txId: string, lovelace: bigint) => out.push({ utxo_ref: `${txId}:0`, tx_out: JSON.stringify({ address, amount: lovelace.toString(), assets: {} }), tx_hash: txId, address, lovelace: lovelace.toString(), reference_script_hash: null, stake_key: null });
    const magic = byron?.protocolConsts?.protocolMagic;
    for (const [pk, bal] of Object.entries((byron?.avvmDistr ?? {}) as Record<string, string | number>)) { const { address, txId } = avvmGenesisAddress(pk, magic); add(address, txId, BigInt(String(bal))); }
    for (const [address, bal] of Object.entries((byron?.nonAvvmBalances ?? {}) as Record<string, string | number>)) add(address, byronGenesisUtxoId(address), BigInt(String(bal)));
    return out;
}

/** Is this Byron (base58) address a redeem (AVVM) address — `isBootstrapRedeemer`? */
export function isRedeemAddress(address: string | null): boolean {
    if (!address || address.startsWith("addr") || address.startsWith("stake")) return false;
    try { return ByronAddress.isValid(address) && byronAddressType(ByronAddress.fromBase58(address)) === 2; } catch { return false; }
}

/** Build the genesis state (pure: no store). Throws on a configuration cardano-node would refuse. */
export async function buildGenesisLedgerState(inp: GenesisInputs): Promise<GenesisLedgerState> {
    const warnings: string[] = [];
    const startEra = startEraAtGenesis(inp.triggers);
    const sh = inp.shelley ?? {};
    const mainnet = Number(inp.networkMagic) === MAINNET_MAGIC;
    let shelleyGenesisHash = inp.shelleyGenesisHash ? String(inp.shelleyGenesisHash).toLowerCase() : null;
    if (inp.shelleyGenesisBytes) {
        const actual = hex(blake2b_256(inp.shelleyGenesisBytes));
        if (shelleyGenesisHash && actual !== shelleyGenesisHash) warnings.push(`the Shelley genesis file hashes to ${actual}, the configuration says ${shelleyGenesisHash} (the configured hash is the initial nonce)`);
        shelleyGenesisHash ??= actual;
    }
    const byronGenesisHash = inp.byronGenesisHash ? String(inp.byronGenesisHash).toLowerCase() : null;
    if (startEra === 0 && !byronGenesisHash) throw new Error("genesis state: a chain that starts in Byron needs the Byron genesis hash (config byronGenesisHash): it is the first block's parent");
    if (startEra === 0 && !inp.byron) throw new Error("genesis state: a chain that starts in Byron needs the Byron genesis file");

    // 1. Byron's genesis UTxO (zero balances included)
    let utxos = inp.byron ? byronGenesisRecords(inp.byron) : [];
    const zeroOutputs = utxos.filter((u) => u.lovelace === "0").length;
    let avvmReturned = 0n;
    const genDelegs = Object.entries((sh.genDelegs ?? {}) as Record<string, { delegate: string; vrf: string }>).map(([gk, d]) => ({ genesisKeyHash: gk.toLowerCase(), delegate: String(d.delegate).toLowerCase(), vrf: String(d.vrf).toLowerCase() }));
    let reserves: bigint | null = null;
    const pools: GenesisPool[] = [];
    const accounts: GenesisAccount[] = [];
    const maxSupply = BigInt(String(sh.maxLovelaceSupply ?? 45_000_000_000_000_000n));

    if (startEra >= 1) {
        // 2. Byron → Shelley at slot 0: zero-value outputs dropped, AVVM outputs stashed
        utxos = utxos.filter((u) => u.lovelace !== "0");
        const stash = utxos.filter((u) => isRedeemAddress(u.address));
        // Shelley → Allegra at slot 0: the stashed AVVM outputs leave the UTxO for the reserves
        if (startEra >= 2 && stash.length) {
            const gone = new Set(stash.map((u) => u.utxo_ref));
            for (const u of stash) avvmReturned += BigInt(u.lovelace!);
            utxos = utxos.filter((u) => !gone.has(u.utxo_ref));
        } else if (stash.length) warnings.push(`${stash.length} AVVM output(s) stashed at genesis are returned at the Allegra boundary`);
        // 3. injectIntoTestState of the start era: initial funds, then staking
        const funds = Object.entries((sh.initialFunds ?? {}) as Record<string, string | number>);
        const staking = sh.staking ?? {};
        const stakePools = Object.entries((staking.pools ?? {}) as Record<string, any>);
        const stake = Object.entries((staking.stake ?? {}) as Record<string, string>);
        if (mainnet && (funds.length || stakePools.length || stake.length)) throw new Error("genesis state: injection of initial funds or staking is not possible on mainnet (protectMainnet)");
        if (startEra >= 4 && inp.alonzo?.extraConfig?.costModels) throw new Error("genesis state: the Alonzo genesis extraConfig cost-model override (alonzoInjectCostModels) is not supported");
        if (startEra >= 6 && (Object.keys(inp.conway?.initialDReps ?? {}).length || Object.keys(inp.conway?.delegs ?? {}).length)) warnings.push("Conway genesis initialDReps / delegs: seeded by the governance boundary (seedGovernance, chainStartsInConway)");
        if (funds.length) {
            const { buildUtxoRowForOutput } = await import("../db");
            const { TxOut } = await import("@harmoniclabs/cardano-ledger-ts");
            const have = new Set(utxos.map((u) => u.utxo_ref));
            for (const [addrHex, amount] of funds) {
                const addr = Uint8Array.from(Buffer.from(addrHex, "hex"));
                const txId = hex(blake2b_256(addr)); // initialFundsPseudoTxIn: blake2b-256 of the serialised address, index 0
                if (have.has(`${txId}:0`)) throw new Error(`genesis state: initial fund ${addrHex} already part of the UTxO`);
                const out = TxOut.fromCbor(cborTxOut(addr, BigInt(String(amount))));
                const row = buildUtxoRowForOutput(txId, 0, out);
                utxos.push({ utxo_ref: row.utxoRef, tx_out: row.txOutJson, tx_hash: txId, address: row.cols.address ?? row.address, lovelace: row.cols.lovelace ?? row.lovelace, reference_script_hash: row.cols.referenceScriptHash ?? null, stake_key: row.cols.stakeKey ?? null });
            }
        }
        for (const [id, p] of stakePools) {
            const m0 = rationalFromDecimal(String(p.margin ?? 0));
            const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
            const gm = gcd(m0.num, m0.den) || 1n, m = { num: m0.num / gm, den: m0.den / gm }; // a Haskell Rational is normalised
            const ra = p.rewardAccount ?? {};
            pools.push({ poolId: id.toLowerCase(), vrf: String(p.vrf).toLowerCase(), params: { pledge: String(p.pledge ?? 0), cost: String(p.cost ?? 0), marginNum: String(m.num), marginDen: String(m.den), rewardAccount: typedCred(ra.credential ?? ra), owners: ((p.owners ?? []) as string[]).map((o) => String(o).toLowerCase()) } });
        }
        const poolIds = new Set(pools.map((p) => p.poolId));
        stake.forEach(([cred, pool], i) => {
            if (!poolIds.has(String(pool).toLowerCase())) throw new Error(`genesis state: delegation of ${cred} to an unregistered stake pool ${pool}`);
            // Shelley…Babbage register a pointer per account (`shelleyRegisterInitialAccounts`); Conway accounts have none
            accounts.push({ cred: cred.toLowerCase(), pool: String(pool).toLowerCase(), ptr: startEra >= 6 ? null : [0, Math.floor(i / 65536), i % 65536] });
        });
        let total = 0n;
        for (const u of utxos) total += BigInt(u.lovelace ?? 0);
        reserves = maxSupply - total; // Shelley: max supply − Σ Byron UTxO, + the AVVM return (Allegra), − the initial funds
    }
    let utxoTotal = 0n;
    for (const u of utxos) utxoTotal += BigInt(u.lovelace ?? 0);
    let rec: GenesisLedgerState["byronRecord"] = null;
    if (startEra === 0) { const st = initialByronLedgerState(byronLedgerConfigFromGenesis(inp.byron)); rec = { core: encodeByronLedgerCore(st), tip: encodeByronLedgerTip(st) }; }
    return { network: inp.network, startEra, firstPrevHash: startEra === 0 ? byronGenesisHash : null, utxos, utxoTotal, zeroOutputs, avvmReturned, genDelegs, reserves, pools, accounts, byronRecord: rec, shelleyGenesisHash, byronGenesisHash, warnings };
}

/** `[address bytes, coin]` — the Shelley TxOut of an initial fund. */
function cborTxOut(addr: Uint8Array, coin: bigint): Uint8Array {
    const head = addr.length < 24 ? [0x40 | addr.length] : addr.length < 256 ? [0x58, addr.length] : [0x59, addr.length >> 8, addr.length & 0xff];
    const c: number[] = [];
    if (coin < 24n) c.push(Number(coin));
    else if (coin < 0x100n) c.push(0x18, Number(coin));
    else if (coin < 0x10000n) c.push(0x19, Number(coin >> 8n), Number(coin & 0xffn));
    else if (coin < 0x100000000n) { c.push(0x1a); for (let s = 24n; s >= 0n; s -= 8n) c.push(Number((coin >> s) & 0xffn)); }
    else { c.push(0x1b); for (let s = 56n; s >= 0n; s -= 8n) c.push(Number((coin >> s) & 0xffn)); }
    return Uint8Array.from([0x82, ...head, ...addr, ...c]);
}

export interface GenesisMeta {
    network: string;
    startEra: number;
    firstPrevHash: string | null;
    byronGenesisHash: string | null;
    shelleyGenesisHash: string | null;
    utxos: number;
    utxoTotal: string;
    reserves: string | null;
    builtAt: string;
}

/** Write the genesis state into an EMPTY store (no anchor, no diffs) and mark it. */
export async function writeGenesisLedgerState(st: LedgerStore, g: GenesisLedgerState): Promise<GenesisMeta> {
    if (st.anchor()) throw new Error("genesis state: the ledger store already has an anchor");
    if (st.volatileCount()) throw new Error("genesis state: the ledger store already holds volatile diffs");
    const has = st.env.read((t) => t.get("meta", GENESIS_META_KEY));
    if (has) throw new Error("genesis state: the ledger store already holds a genesis state");
    const u = new UtxoWrites(st), w = new StakeWrites(st);
    for (let i = 0; i < g.utxos.length; i += 20_000) {
        const slice = g.utxos.slice(i, i + 20_000);
        await st.applyDirect(() => { for (const r of slice) u.put(r); });
    }
    await st.applyDirect(() => {
        for (const d of g.genDelegs) w.recordGenesisDelegation(d.genesisKeyHash, d.delegate, d.vrf, 0);
        if (g.reserves != null) w.putPots({ reserves: g.reserves, treasury: 0n, feePot: 0n, donationPot: 0n, initializedEpoch: 0 });
        for (const p of g.pools) w.putPool(p.poolId, { vrf: p.vrf, registeredSlot: 0, retiringEpoch: null, params: p.params });
        for (const a of g.accounts) { w.registerStake(a.cred); w.delegate(a.cred, a.pool); if (a.ptr) w.putPointer(a.ptr[0], a.ptr[1], a.ptr[2], a.cred); }
        if (g.byronRecord) { st.put(BYRON_DB, enc.encode("core"), enc.encode(g.byronRecord.core)); st.put(BYRON_DB, enc.encode("tip"), enc.encode(g.byronRecord.tip)); }
        if (g.startEra === 1) for (const r of g.utxos) if (isRedeemAddress(r.address)) st.put(AVVM_STASH_DB, refKey(r.utxo_ref), new Uint8Array(0));
    });
    const meta: GenesisMeta = { network: g.network, startEra: g.startEra, firstPrevHash: g.firstPrevHash, byronGenesisHash: g.byronGenesisHash, shelleyGenesisHash: g.shelleyGenesisHash, utxos: g.utxos.length, utxoTotal: g.utxoTotal.toString(), reserves: g.reserves?.toString() ?? null, builtAt: new Date().toISOString() };
    await st.env.write((t) => t.put("meta", GENESIS_META_KEY, enc.encode(JSON.stringify(meta))));
    return meta;
}

/** The genesis record of a store built from genesis (null for a snapshot import or a SQLite seed). */
export function readGenesisMeta(st: LedgerStore | { env: LedgerStore["env"] }): GenesisMeta | null {
    const raw = st.env.read((t) => t.get("meta", GENESIS_META_KEY));
    if (!raw) return null;
    try { return JSON.parse(dec.decode(raw)) as GenesisMeta; } catch { return null; }
}

/**
 * Byron → Shelley translation at the first Shelley boundary of a chain that started in Byron
 * (`translateToShelleyLedgerState`): zero-value outputs leave the UTxO, redeem (AVVM) outputs are
 * stashed for the Allegra boundary. Runs inside the boundary block's diff, before the reserves are
 * computed (a zero output changes no sum). Returns what it did.
 */
export function translateByronUtxoAtShelleyStart(st: LedgerStore): { zeroDropped: number; avvmStashed: number; avvmLovelace: bigint } {
    const zero: string[] = [], stash: Array<[string, bigint]> = [];
    for (const [k, v] of st.range(DB_UTXO, new Uint8Array(0))) {
        const lovelace = new DataView(v.buffer, v.byteOffset).getBigUint64(1, false);
        const ref = keyRef(k);
        if (lovelace === 0n) { zero.push(ref); continue; }
        const r = decodeRow(ref, v);
        if (isRedeemAddress(r.address)) stash.push([ref, lovelace]);
    }
    if (zero.length) new UtxoWrites(st).del(zero);
    let avvmLovelace = 0n;
    for (const [ref, l] of stash) { st.put(AVVM_STASH_DB, refKey(ref), new Uint8Array(0)); avvmLovelace += l; }
    return { zeroDropped: zero.length, avvmStashed: stash.length, avvmLovelace };
}

/**
 * Shelley → Allegra translation (`translateEra` Allegra, `returnRedeemAddrsToReserves`): the stashed
 * AVVM outputs still in the UTxO are removed and their sum added to the reserves; the stash is
 * cleared. Inside the boundary block's diff. Idempotent (an empty stash does nothing).
 */
export function returnStashedAvvm(st: LedgerStore): { returned: number; lovelace: bigint } {
    const refs: string[] = [];
    for (const [k] of st.range(AVVM_STASH_DB, new Uint8Array(0))) refs.push(keyRef(k));
    if (!refs.length) return { returned: 0, lovelace: 0n };
    const gone = new UtxoWrites(st).del(refs);
    let lovelace = 0n;
    for (const r of gone) lovelace += BigInt(r.lovelace ?? 0);
    for (const ref of refs) st.del(AVVM_STASH_DB, refKey(ref));
    if (lovelace > 0n) new StakeWrites(st).updatePots({ reserves: lovelace, treasury: 0n, resetFees: false });
    return { returned: gone.length, lovelace };
}

/** Sum and count of the UTxO (a full scan) over a store or a view. */
export function utxoTotals(s: LedgerStore | LedgerView): { count: number; lovelace: bigint } {
    let count = 0, lovelace = 0n;
    for (const [, v] of s.range(DB_UTXO, new Uint8Array(0))) { count++; lovelace += new DataView(v.buffer, v.byteOffset).getBigUint64(1, false); }
    return { count, lovelace };
}
