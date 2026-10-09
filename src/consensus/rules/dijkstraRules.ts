/**
 * Dijkstra ledger rules (era 8, protocol 12), ported from cardano-ledger eras/dijkstra
 * (tag cardano-ledger-dijkstra-0.4.0.0 = master 2026-10-08). Only reached for era-8 blocks,
 * which exist only with ExperimentalHardForksEnabled (bug 421): nothing here runs for
 * Byron..Conway.
 *
 * What changes against Conway, and where it is enforced:
 *   - BBODY (bug 427): `HeaderProtVerTooLow` (the header's highest supported major must be at
 *     least the current one; Conway's `HeaderProtVerTooHigh` is gone), `PerasCertValidationFailed`
 *     (any Peras certificate: the ledger's placeholder validator always says no), and the Leios
 *     prototype rules gouroboros enforces (CIP-0164: the header's certified flag equals the
 *     certificate's presence; a certified block carries no transactions). The Leios certificate's
 *     BLS aggregate is not verified (no voting committee yet): a report.
 *   - UTXO (bug 428): value is conserved over the whole batch (the top-level transaction and its
 *     sub-transactions), direct deposits are produced value.
 *   - UTXOW: `MissingRequiredGuards` (every credential a body lists in
 *     `required_top_level_guards` is a top-level guard), `MalformedGuardDatums`, script guards
 *     need their script.
 *   - ENTITIES: direct deposits and account balance intervals (wrong network, missing account,
 *     balance outside the interval; the starting intervals against the balances before the
 *     batch), withdrawals may be partial unless the transaction runs a Plutus V1..V3 script
 *     ("legacy mode": then they must drain the account, as in Conway), and
 *     `ConwayWdrlNotDelegatedToDRep` no longer exists.
 *   - LEDGER: the reference-script limits and tier price come from the protocol parameters.
 * Sub-transactions: their inputs are resolved, their vkey witnesses verified and their effects
 * applied; the rest of SUBLEDGER (sub-tx scripts, Plutus V4 contexts) is reported, not enforced.
 */
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { utxoRefOf } from "./resolvedUtxo";
import { addAll, addUnit, unitsOf, type UnitMap } from "./value";
import { certDepositsAndRefunds, rewardAccountKey, type RuleSink } from "./ledgerChecks";

export const DIJKSTRA_ERA = 8;
export const isDijkstraEra = (era: number | bigint): boolean => Number(era) >= DIJKSTRA_ERA;

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();
const toHexBytes = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** The sub-transactions of a top-level Dijkstra body (`[]` for any other body). */
export function subTransactionsOf(body: any): any[] {
    const s = body?.subTransactions;
    return Array.isArray(s) ? s : [];
}
export function subBodiesOf(body: any): any[] {
    return subTransactionsOf(body).map((s) => s?.body ?? s);
}

/** Typed credential hex (db/stakeCred.ts convention: script hashes prefixed with 01) of a 29-byte reward account. */
export function rewardBytesKey(bytes: Uint8Array): string {
    const h = toHexBytes(bytes.subarray(1));
    return (bytes[0]! >> 4) === 0xf ? `01${h}` : h;
}
export function rewardBytesNetwork(bytes: Uint8Array): "mainnet" | "testnet" {
    return (bytes[0]! & 0x0f) === 1 ? "mainnet" : "testnet";
}

/** Entries of a `TxWithdrawals`-shaped map (withdrawals, direct deposits): typed key, network, amount. */
export function rewardMapEntries(m: any): Array<{ key: string; network: string | null; amount: bigint }> {
    const out: Array<{ key: string; network: string | null; amount: bigint }> = [];
    for (const w of (m?.map ?? []) as any[]) out.push({ key: rewardAccountKey(w.rewardAccount), network: w?.rewardAccount?.network ?? null, amount: BigInt(w?.amount ?? 0) });
    return out;
}

/** Inputs, reference inputs and certificates' pools of every sub-transaction (for the block reads). */
export function subTransactionReads(body: any): { refs: string[]; poolIds: string[]; creds: string[] } {
    const refs: string[] = [], poolIds: string[] = [], creds: string[] = [];
    for (const sb of subBodiesOf(body)) {
        for (const list of [sb.inputs, sb.refInputs] as any[][]) for (const i of list ?? []) { const r = utxoRefOf(i); if (r) refs.push(r); }
        for (const c of (sb.certs ?? []) as any[]) if (Number(c.certType) === 3) poolIds.push(String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
        for (const e of rewardMapEntries(sb.withdrawals)) creds.push(e.key);
    }
    for (const sb of [body, ...subBodiesOf(body)]) {
        for (const e of rewardMapEntries(sb?.directDeposits)) creds.push(e.key);
        for (const list of [sb?.accountBalanceIntervals, sb?.startingAccountBalanceIntervals] as any[][]) for (const e of list ?? []) if (e?.rewardAccount instanceof Uint8Array) creds.push(rewardBytesKey(e.rewardAccount));
    }
    return { refs, poolIds, creds };
}

export interface BatchValueContext {
    resolved: Map<string, ResolvedUtxo>;
    keyDeposit: bigint;
    poolDeposit: bigint;
    drepDeposit: bigint | null;
    isPoolRegistered: (poolHex: string) => boolean;
    stakeDeposit?: (typedCredHex: string) => bigint | null;
}

/**
 * What the batch adds to the top-level body's consumed / produced (Dijkstra `consumed` /
 * `produced` over `allInputs` / `allOutputs`): every sub-transaction's spent inputs, mint,
 * withdrawals and refunds; its outputs, donation, proposal and certificate deposits and direct
 * deposits; and the top-level body's own direct deposits. `missing` lists sub-tx inputs that
 * are not in the UTxO before the batch.
 */
export function dijkstraBatchValue(body: any, ctx: BatchValueContext): { consumed: UnitMap; produced: UnitMap; missing: string[] } {
    const consumed: UnitMap = new Map(), produced: UnitMap = new Map();
    const missing: string[] = [];
    for (const e of rewardMapEntries(body?.directDeposits)) addUnit(produced, "lovelace", e.amount);
    for (const sb of subBodiesOf(body)) {
        for (const i of (sb.inputs ?? []) as any[]) {
            const r = utxoRefOf(i);
            const u = r ? ctx.resolved.get(r) : undefined;
            if (u) addAll(consumed, u.value); else if (r) missing.push(r);
        }
        if (sb.mint) addAll(consumed, unitsOf(sb.mint));
        for (const e of rewardMapEntries(sb.withdrawals)) addUnit(consumed, "lovelace", e.amount);
        for (const o of (sb.outputs ?? []) as any[]) addAll(produced, unitsOf(o.value));
        if (sb.donation != null) addUnit(produced, "lovelace", BigInt(sb.donation));
        for (const p of (sb.proposalProcedures ?? []) as any[]) addUnit(produced, "lovelace", BigInt(p.deposit ?? 0));
        const cd = certDepositsAndRefunds((sb.certs ?? []) as any[], { keyDeposit: ctx.keyDeposit, poolDeposit: ctx.poolDeposit, drepDeposit: ctx.drepDeposit }, ctx.isPoolRegistered, ctx.stakeDeposit);
        addUnit(produced, "lovelace", cd.deposits);
        addUnit(consumed, "lovelace", cd.refunds);
        for (const e of rewardMapEntries(sb.directDeposits)) addUnit(produced, "lovelace", e.amount);
    }
    return { consumed, produced, missing };
}

/** Is the transaction in Plutus "legacy mode" (it runs a Plutus V1..V3 script; Dijkstra.hs `dsattPlutusLegacyMode`)? */
export function plutusLegacyMode(neededScripts: Iterable<string>, languages: ReadonlyMap<string, number>): boolean {
    for (const h of neededScripts) { const l = languages.get(h); if (l != null && l <= 3) return true; }
    return false;
}

export interface DijkstraTxCheckInput {
    body: any;
    network: "mainnet" | "testnet";
    /** Reward balances (typed hex) before the batch; undefined when not tracked. */
    rewardBalances?: Map<string, bigint>;
    /** Is the account (typed hex) registered before the transaction? null = unknown. */
    stakeRegistered?: (typedCredHex: string) => boolean | null;
    /** Scripts available to the transaction (witness set and reference scripts): hash → native or Plutus. */
    providedScripts: ReadonlyMap<string, { kind: "native" | "plutus" }>;
    /** Plutus legacy mode (see `plutusLegacyMode`). */
    legacyMode: boolean;
    /** Are the balances exact (strict rules), and why not. */
    strict: boolean;
    why?: string;
}

/** Keys (typed hex) of the credentials of a key-hash or credential guard list. */
function guardKeys(guards: any[] | undefined): Set<string> {
    const out = new Set<string>();
    for (const g of guards ?? []) {
        const isCred = g?.type !== undefined && g?.hash !== undefined;
        const h = hex(isCred ? g.hash : g);
        out.add(isCred && Number(g.type) === 1 ? `01${h}` : h);
    }
    return out;
}

/** UTXOW / ENTITIES rules that are new in Dijkstra (see the file header). */
export function checkDijkstraTx(sink: RuleSink, t: DijkstraTxCheckInput): void {
    const body = t.body;
    const subs = subBodiesOf(body);
    const soft = (msg: string) => (t.strict ? sink.failures : sink.reports).push(t.strict ? msg : `${msg} (report-only: ${t.why || "reward balances not proven exact"})`);

    // UTXOW MissingRequiredGuards: required_top_level_guards of the batch ⊆ top-level guards
    const top = guardKeys(body?.guards);
    const required = new Map<string, any>();
    for (const b of [body, ...subs]) for (const e of (b?.requiredTopLevelGuards ?? []) as any[]) required.set(guardKeys([e.credential]).values().next().value!, e);
    const missingGuards = [...required.keys()].filter((k) => !top.has(k));
    if (missingGuards.length) sink.failures.push(`MissingRequiredGuards: ${missingGuards.length} credential(s) required by a body are not top-level guards: ${missingGuards.slice(0, 2).map((k) => k.slice(0, 14) + "…").join(", ")}`);
    // UTXOW MalformedGuardDatums (per body): key hashes and native scripts carry no datum, Plutus scripts carry one
    for (const b of [body, ...subs]) for (const e of (b?.requiredTopLevelGuards ?? []) as any[]) {
        const isScript = Number(e?.credential?.type) === 1;
        const script = isScript ? t.providedScripts.get(hex(e.credential.hash)) : undefined;
        if (isScript && !script) continue; // unknown script: the ledger skips it too
        const wantsDatum = isScript && script!.kind === "plutus";
        if ((e.data != null) !== wantsDatum) sink.failures.push(`MalformedGuardDatums: guard ${hex(e.credential.hash).slice(0, 12)}… ${wantsDatum ? "needs" : "must not carry"} a datum`);
    }

    // ENTITIES: direct deposits (top level; the sub-transactions' ones are SUBENTITIES)
    const registeredAfterCerts = (key: string, certs: any[]): boolean | null => {
        let reg = t.stakeRegistered ? t.stakeRegistered(key) : null;
        for (const c of certs) {
            const ty = Number(c?.certType);
            const k = c?.stakeCredential ? (Number(c.stakeCredential.type) === 1 ? `01${hex(c.stakeCredential.hash)}` : hex(c.stakeCredential.hash)) : null;
            if (k !== key) continue;
            if (ty === 7 || ty === 11 || ty === 12 || ty === 13) reg = true;
            else if (ty === 8) reg = false;
        }
        return reg;
    };
    for (const b of [body, ...subs]) {
        for (const e of rewardMapEntries(b?.directDeposits)) {
            if (e.network && e.network !== t.network) sink.failures.push(`DirectDepositAddressesWithWrongNetwork: ${e.key.slice(0, 12)}… on ${e.network}, node is on ${t.network}`);
            const reg = registeredAfterCerts(e.key, (b.certs ?? []) as any[]);
            if (reg === null) sink.reports.push(`direct deposit to ${e.key.slice(0, 12)}…: registration unknown`);
            else if (!reg) sink.failures.push(`DirectDepositAccountsMissing: ${e.key.slice(0, 12)}… is not registered`);
        }
    }

    // ENTITIES: balances before the batch, after the sub-transactions (withdrawals, direct deposits)
    const before = t.rewardBalances;
    const afterSubs = before ? new Map(before) : undefined;
    if (afterSubs) for (const sb of subs) {
        for (const e of rewardMapEntries(sb.withdrawals)) afterSubs.set(e.key, (afterSubs.get(e.key) ?? 0n) - e.amount);
        for (const e of rewardMapEntries(sb.directDeposits)) afterSubs.set(e.key, (afterSubs.get(e.key) ?? 0n) + e.amount);
    }
    const checkIntervals = (list: any[] | undefined, balances: Map<string, bigint> | undefined, rule: string) => {
        for (const e of list ?? []) {
            const bytes: Uint8Array | undefined = e?.rewardAccount;
            if (!(bytes instanceof Uint8Array)) continue;
            const key = rewardBytesKey(bytes);
            if (rewardBytesNetwork(bytes) !== t.network) { sink.failures.push(`WrongNetworkIn${rule}: ${key.slice(0, 12)}…`); continue; }
            const reg = t.stakeRegistered ? t.stakeRegistered(key) : null;
            if (reg === false) { sink.failures.push(`MissingAccountsIn${rule}: ${key.slice(0, 12)}…`); continue; }
            const bal = balances?.get(key);
            if (bal == null) { sink.reports.push(`${rule}: balance of ${key.slice(0, 12)}… unknown`); continue; }
            if (!e.interval.contains(bal)) soft(`BalancesOutside${rule}: ${key.slice(0, 12)}… has ${bal}, interval ${JSON.stringify(e.interval.toJson(), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        }
    };
    checkIntervals(body?.accountBalanceIntervals, afterSubs, "AccountBalanceIntervals");
    checkIntervals(body?.startingAccountBalanceIntervals, before, "StartingAccountBalanceIntervals");
    for (const sb of subs) checkIntervals(sb.accountBalanceIntervals, before, "AccountBalanceIntervals (sub-transaction)");

    // ENTITIES withdrawals: partial withdrawals unless in legacy mode
    if (before) {
        const total = new Map<string, bigint>();
        const add = (b: any) => { for (const e of rewardMapEntries(b?.withdrawals)) total.set(e.key, (total.get(e.key) ?? 0n) + e.amount); };
        if (!t.legacyMode) add(body);
        for (const sb of subs) add(sb);
        for (const [k, amt] of total) {
            const bal = before.get(k);
            if (bal == null) continue; // missing accounts: WithdrawalAccountsMissing (checkWithdrawalAccounts)
            if (amt > bal) soft(`WithdrawalAmountsExceedingOriginalBalance: ${amt} > ${bal} for ${k.slice(0, 12)}…`);
        }
        if (t.legacyMode) for (const e of rewardMapEntries(body?.withdrawals)) {
            const bal = afterSubs?.get(e.key);
            if (bal != null && bal !== e.amount) soft(`WithdrawalAmountsInexactInLegacyMode: withdrawal ${e.amount} ≠ reward balance ${bal} for ${e.key.slice(0, 12)}…`);
        }
    }

    if (subs.length) sink.reports.push(`${subs.length} sub-transaction(s): SUBLEDGER script and Plutus rules not enforced (bug 428)`);
}

export interface DijkstraBlockCheckInput {
    block: any;
    /** Current protocol major (the ledger's `ppProtocolVersion`); null = unknown. */
    protocolMajor: number | null;
}

/** BBODY rules new in Dijkstra plus the Leios prototype consistency checks (see the file header). */
export function checkDijkstraBlock(sink: RuleSink, t: DijkstraBlockCheckInput): void {
    const b = t.block;
    const hb = b?.header?.body;
    const highest = hb?.protocolVersion?.major != null ? Number(hb.protocolVersion.major) : null;
    if (highest != null && t.protocolMajor != null && highest < t.protocolMajor) sink.failures.push(`HeaderProtVerTooLow: header supports up to ${highest}, the ledger is at ${t.protocolMajor}`);
    if (b?.perasCertificate != null) sink.failures.push("PerasCertValidationFailed: Peras certificates are not accepted yet (cardano-ledger validatePerasCert)");
    const hasLeios = b?.leiosCertificate != null;
    if (hb && typeof hb.leiosCertified === "boolean" && hb.leiosCertified !== hasLeios) sink.failures.push(`Leios certified flag ${hb.leiosCertified} does not match the block body (${hasLeios ? "a" : "no"} certificate)`);
    if (hasLeios && (b.transactions?.length ?? 0) > 0) sink.failures.push(`LeiosCertifiedBlockTransactions: a certified block carries ${b.transactions.length} transaction(s) (CIP-0164)`);
    if (hasLeios) sink.reports.push("Leios certificate signature not verified (no voting committee)");
}

/**
 * Original auxiliary-data bytes of each transaction of a Dijkstra block `[header, block_body]`
 * (`block_transaction = [body, wits, aux / nil, is_valid]`), by transaction index. The decoder's own
 * slice of a tag-259 value is a re-encoding; the ledger hashes the bytes as carried.
 */
export function dijkstraBlockAuxDataBytes(blockBytes: Uint8Array): Map<number, Uint8Array> | null {
    try {
        const lazy = (b: Uint8Array): Uint8Array[] => { const x: any = Cbor.parseLazy(b); if (!(x instanceof LazyCborArray)) throw new Error("not an array"); return x.array; };
        const body = lazy(blockBytes)[1]!;
        const txs = lazy(lazy(body)[0]!);
        const out = new Map<number, Uint8Array>();
        txs.forEach((tx, i) => { const aux = lazy(tx)[2]!; if (!(aux.length === 1 && aux[0] === 0xf6)) out.set(i, aux); });
        return out;
    } catch {
        return null;
    }
}

/** Dijkstra protocol parameters that replace Conway constants (raw keys as stored, Blockfrost-shaped). */
export function dijkstraRefScriptParams(raw: Record<string, unknown> | null | undefined): { maxPerTx: number | null; maxPerBlock: number | null; stride: number | null; multiplier: { num: bigint; den: bigint } | null } {
    const n = (k: string) => raw?.[k] != null && Number.isFinite(Number(raw[k])) ? Number(raw[k]) : null;
    let multiplier: { num: bigint; den: bigint } | null = null;
    const m = raw?.ref_script_cost_multiplier;
    if (m != null) {
        const s = String(m);
        const slash = s.indexOf("/");
        if (slash > 0) multiplier = { num: BigInt(s.slice(0, slash)), den: BigInt(s.slice(slash + 1)) };
        else if (/^\d+(\.\d+)?$/.test(s)) { const [i = "0", f = ""] = s.split("."); const den = 10n ** BigInt(f.length); multiplier = { num: BigInt(i) * den + BigInt(f || "0"), den }; }
    }
    return { maxPerTx: n("max_ref_script_size_per_tx"), maxPerBlock: n("max_ref_script_size_per_block"), stride: n("ref_script_cost_stride"), multiplier };
}
