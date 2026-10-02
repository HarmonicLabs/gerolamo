/**
 * Conway `ApplyTxErr` as cardano-node sends it in LocalTxSubmission's MsgRejectTx, and the
 * collector that orders predicate failures the way cardano-ledger's small-steps engine does.
 *
 * Wire shape (ouroboros-consensus `dispatchEncoderErr` + `encodeEitherMismatch`, ledger
 * `ConwayApplyTxError` = NonEmpty ConwayLedgerPredFailure), captured from the cardano-node
 * 11.0.1 preview relay on 2026-09-28:
 *
 *   MsgRejectTx = [2, [[6, [ledgerFailure, …]]]]      -- [listLen 1, [eraIndex 6 = Conway, …]]
 *   ledgerFailure = [1, utxowFailure] | [2, certsFailure] | [3, govFailure] | [6, supplied, max] | [7, text] | …
 *   utxowFailure  = [0, utxoFailure] | [2, #6.258([keyhash…])] | [3, #6.258([scripthash…])] | [15, [purpose…]] | [18, …] | …
 *   utxoFailure   = [0, utxosFailure] | [1, #6.258([txin…])] | [2, [[before?], [after?]], slot] | [5, minFee, fee] | [6, consumed, produced] | …
 *
 * Order: small-steps (`applyRuleInternal`) prepends a predicate's failures (reversed) to the
 * rule's list and prepends each of a sub-rule's failures in turn, so a sub-rule's block keeps
 * its execution order and lands *before* the parent's own earlier failures; the MEMPOOL rule's
 * list is returned as is. `RuleRun` reproduces that exactly (see the unit tests for the
 * captured four-failure case BadInputs, ValueNotConserved, OutputTooSmall, MissingVKeyWitnesses).
 */
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, CborSimple, CborTag, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";

export const CONWAY_ERA_INDEX = 6;

const U = (n: number | bigint) => new CborUInt(typeof n === "bigint" ? n : BigInt(n));
const I = (n: bigint) => (n < 0n ? new CborNegInt(n) : new CborUInt(n));
const Bs = (b: Uint8Array) => new CborBytes(b);
const hexBytes = (h: string) => new CborBytes(Uint8Array.from(Buffer.from(h, "hex")));
const sum = (tag: number, ...fields: CborObj[]) => new CborArray([U(tag), ...fields]);

/** Ascending by bytes, as Haskell's `Ord ShortByteString` / `Ord (Hash …)` order them. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
}

/** `Set a` from protocol version 9 on: tag 258 over a definite list in ascending order. */
/**
 * Haskell `Ord RewardAccount`: network (Testnet < Mainnet), then the credential with
 * `ScriptHashObj` before `KeyHashObj` (constructor order), then the hash — not byte order
 * (a key account's header e0 sorts before a script's f0 bytewise).
 */
export function compareRewardAccounts(a: Uint8Array, b: Uint8Array): number {
    const na = a[0]! & 0x0f, nb = b[0]! & 0x0f;
    if (na !== nb) return na - nb;
    const sa = (a[0]! & 0x10) ? 0 : 1, sb = (b[0]! & 0x10) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return compareBytes(a.subarray(1), b.subarray(1));
}

export function cborSet(items: CborObj[]): CborTag {
    return new CborTag(258, new CborArray(items));
}
export function hashSet(hexes: Iterable<string>): CborTag {
    const bytes = [...new Set([...hexes].map((h) => h.toLowerCase()))].map((h) => Uint8Array.from(Buffer.from(h, "hex")));
    bytes.sort(compareBytes);
    return cborSet(bytes.map(Bs));
}

export interface TxInRef { txId: string; index: number }
export function parseRef(ref: string): TxInRef {
    const i = ref.lastIndexOf(":");
    return { txId: ref.slice(0, i).toLowerCase(), index: Number(ref.slice(i + 1)) };
}
export function compareRefs(a: TxInRef, b: TxInRef): number {
    return a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : a.index - b.index;
}
export const txInCbor = (r: TxInRef) => new CborArray([hexBytes(r.txId), U(r.index)]);
export function txInSet(refs: Iterable<string>): CborTag {
    const list = [...new Set(refs)].map(parseRef).sort(compareRefs);
    return cborSet(list.map(txInCbor));
}

/** `StrictMaybe a`: `[]` or `[a]`. */
export const strictMaybe = (x: CborObj | null) => new CborArray(x ? [x] : []);

/** MaryValue: a bare coin without assets, else `[coin, {policy: {name: qty}}]` (maps in key order). */
export function valueCbor(units: Map<string, bigint>): CborObj {
    const coin = units.get("lovelace") ?? 0n;
    const byPolicy = new Map<string, Map<string, bigint>>();
    for (const [unit, q] of units) {
        if (unit === "lovelace" || q === 0n) continue;
        const policy = unit.slice(0, 56).toLowerCase(), name = unit.slice(56).toLowerCase();
        let m = byPolicy.get(policy);
        if (!m) byPolicy.set(policy, (m = new Map()));
        m.set(name, (m.get(name) ?? 0n) + q);
    }
    if (byPolicy.size === 0) return I(coin);
    const policies = [...byPolicy.keys()].sort();
    return new CborArray([I(coin), new CborMap(policies.map((p) => {
        const names = [...byPolicy.get(p)!.entries()].map(([n, q]) => ({ n: Uint8Array.from(Buffer.from(n, "hex")), q })).sort((a, b) => compareBytes(a.n, b.n));
        return { k: hexBytes(p), v: new CborMap(names.map(({ n, q }) => ({ k: Bs(n), v: I(q) }))) };
    }))]);
}

/**
 * BabbageTxOut as the ledger re-encodes it (not the submitted bytes): `[addr, value]` without
 * datum or script, `[addr, value, datumHash]` with only a datum hash, the map form otherwise
 * (relay capture: a map-form output without datum came back as a two-element list).
 */
export interface TxOutParts {
    address: Uint8Array;
    value: Map<string, bigint>;
    datumHash?: string | null;
    inlineDatumCbor?: Uint8Array | null;
    /** `script` CBOR as carried in `script_ref` (`[lang, bytes]`), without the tag-24 wrapper. */
    scriptRefCbor?: Uint8Array | null;
}
export function txOutCbor(o: TxOutParts): CborObj {
    const hasInline = !!o.inlineDatumCbor, hasScript = !!o.scriptRefCbor;
    if (!hasInline && !hasScript) {
        return o.datumHash ? new CborArray([Bs(o.address), valueCbor(o.value), hexBytes(o.datumHash)]) : new CborArray([Bs(o.address), valueCbor(o.value)]);
    }
    const m: Array<{ k: CborObj; v: CborObj }> = [{ k: U(0), v: Bs(o.address) }, { k: U(1), v: valueCbor(o.value) }];
    if (hasInline) m.push({ k: U(2), v: new CborArray([U(1), new CborTag(24, Bs(o.inlineDatumCbor!))]) });
    else if (o.datumHash) m.push({ k: U(2), v: new CborArray([U(0), hexBytes(o.datumHash)]) });
    if (hasScript) m.push({ k: U(3), v: new CborTag(24, Bs(o.scriptRefCbor!)) });
    return new CborMap(m);
}

export const exUnitsCbor = (mem: bigint, steps: bigint) => new CborArray([U(mem), U(steps)]);

/** Stake credential `[0, keyhash] | [1, scripthash]`. */
export const credentialCbor = (type: number, hashHex: string) => new CborArray([U(type === 1 ? 1 : 0), hexBytes(hashHex)]);

// ───────────────────────── failure constructors (already encoded, by rule) ─────────────────────────

/** ConwayUtxoPredFailure (UTXO rule). */
export const UtxoF = {
    utxos: (inner: CborObj) => sum(0, inner),
    badInputs: (refs: Iterable<string>) => sum(1, txInSet(refs)),
    outsideValidityInterval: (before: bigint | null, after: bigint | null, slot: bigint) =>
        sum(2, new CborArray([strictMaybe(before != null ? U(before) : null), strictMaybe(after != null ? U(after) : null)]), U(slot)),
    maxTxSize: (size: bigint, max: bigint) => sum(3, U(size), U(max)),
    inputSetEmpty: () => sum(4),
    /** Serialised expected (minimum) first, then supplied. */
    feeTooSmall: (minFee: bigint, fee: bigint) => sum(5, U(minFee), U(fee)),
    valueNotConserved: (consumed: Map<string, bigint>, produced: Map<string, bigint>) => sum(6, valueCbor(consumed), valueCbor(produced)),
    wrongNetwork: (network: number, addrs: Uint8Array[]) => sum(7, U(network), cborSet([...addrs].sort(compareBytes).map(Bs))),
    wrongNetworkWithdrawal: (network: number, accounts: Uint8Array[]) => sum(8, U(network), cborSet([...accounts].sort(compareRewardAccounts).map(Bs))),
    outputTooBig: (outs: Array<{ size: number; max: number; out: TxOutParts }>) => sum(11, new CborArray(outs.map((o) => new CborArray([U(o.size), U(o.max), txOutCbor(o.out)])))),
    insufficientCollateral: (balance: bigint, required: bigint) => sum(12, I(balance), U(required)),
    scriptsNotPaid: (entries: Array<{ ref: string; out: TxOutParts }>) =>
        sum(13, new CborMap([...entries].sort((a, b) => compareRefs(parseRef(a.ref), parseRef(b.ref))).map((e) => ({ k: txInCbor(parseRef(e.ref)), v: txOutCbor(e.out) })))),
    /** Serialised maximum first, then supplied. */
    exUnitsTooBig: (max: [bigint, bigint], supplied: [bigint, bigint]) => sum(14, exUnitsCbor(...max), exUnitsCbor(...supplied)),
    collateralContainsNonAda: (value: Map<string, bigint>) => sum(15, valueCbor(value)),
    /** Serialised expected (the node's network) first, then the body's. */
    wrongNetworkInTxBody: (expected: number, supplied: number) => sum(16, U(expected), U(supplied)),
    /** Serialised maximum first, then supplied. */
    tooManyCollateralInputs: (max: number, supplied: number) => sum(18, U(max), U(supplied)),
    noCollateralInputs: () => sum(19),
    incorrectTotalCollateral: (balance: bigint, declared: bigint) => sum(20, I(balance), U(declared)),
    outputTooSmall: (outs: Array<{ out: TxOutParts; minCoin: bigint }>) => sum(21, new CborArray(outs.map((o) => new CborArray([txOutCbor(o.out), U(o.minCoin)])))),
    nonDisjointRefInputs: (refs: string[]) => sum(22, new CborArray(refs.map(parseRef).sort(compareRefs).map(txInCbor))),
};

/** ConwayUtxosPredFailure (UTXOS rule): `ValidationTagMismatch isValid (FailedUnexpectedly [PlutusFailure text bytes])`. */
export const UtxosF = {
    validationTagMismatch: (isValid: boolean, failures: Array<{ message: string; context: Uint8Array }>) =>
        sum(0, new CborSimple(isValid), sum(1, new CborArray(failures.map((f) => sum(1, new CborText(f.message), Bs(f.context)))))),
};

/** ConwayUtxowPredFailure (UTXOW rule). */
export const UtxowF = {
    utxo: (inner: CborObj) => sum(0, inner),
    invalidWitnesses: (vkeys: Uint8Array[]) => sum(1, new CborArray(vkeys.map(Bs))),
    missingVKeyWitnesses: (keyHashes: Iterable<string>) => sum(2, hashSet(keyHashes)),
    missingScriptWitnesses: (scriptHashes: Iterable<string>) => sum(3, hashSet(scriptHashes)),
    scriptWitnessNotValidating: (scriptHashes: Iterable<string>) => sum(4, hashSet(scriptHashes)),
    missingTxBodyMetadataHash: (hashHex: string) => sum(5, hexBytes(hashHex)),
    missingTxMetadata: (hashHex: string) => sum(6, hexBytes(hashHex)),
    conflictingMetadataHash: (supplied: string, expected: string) => sum(7, hexBytes(supplied), hexBytes(expected)),
    extraneousScriptWitnesses: (scriptHashes: Iterable<string>) => sum(9, hashSet(scriptHashes)),
    missingRequiredDatums: (missing: Iterable<string>, received: Iterable<string>) => sum(11, hashSet(missing), hashSet(received)),
    notAllowedSupplementalDatums: (unallowed: Iterable<string>, acceptable: Iterable<string>) => sum(12, hashSet(unallowed), hashSet(acceptable)),
    unspendableUtxoNoDatumHash: (refs: Iterable<string>) => sum(14, txInSet(refs)),
    /** Purposes `AsIx`: `[tag, index]` in redeemer order. */
    extraRedeemers: (purposes: Array<[number, number]>) => sum(15, new CborArray(purposes.map(([t, i]) => new CborArray([U(t), U(i)])))),
    /** `Mismatch (StrictMaybe supplied) (StrictMaybe expected)` then `StrictMaybe preimage`. */
    scriptIntegrityHashMismatch: (supplied: string | null, expected: string | null, preimage: Uint8Array | null) =>
        sum(18, new CborArray([strictMaybe(supplied ? hexBytes(supplied) : null), strictMaybe(expected ? hexBytes(expected) : null)]), strictMaybe(preimage ? Bs(preimage) : null)),
};

/** ConwayDelegPredFailure inside CERT inside CERTS. */
export const CertsF = {
    /** Protocol < 11: WithdrawalsNotInRewardsCERTS with the offending withdrawals. */
    withdrawalsNotInRewards: (entries: Array<{ account: Uint8Array; amount: bigint }>) =>
        sum(0, new CborMap([...entries].sort((a, b) => compareRewardAccounts(a.account, b.account)).map((e) => ({ k: Bs(e.account), v: U(e.amount) })))),
    deleg: (inner: CborObj) => sum(1, sum(1, inner)), // CertFailure (DelegFailure inner)
    stakeKeyRegistered: (credType: number, hashHex: string) => sum(2, credentialCbor(credType, hashHex)),
    stakeKeyNotRegistered: (credType: number, hashHex: string) => sum(3, credentialCbor(credType, hashHex)),
    delegateeStakePoolNotRegistered: (poolHex: string) => sum(6, hexBytes(poolHex)),
};

/** ConwayLedgerPredFailure (LEDGER rule, and the MEMPOOL rule's own failures). */
export const LedgerF = {
    utxow: (inner: CborObj) => sum(1, inner),
    certs: (inner: CborObj) => sum(2, inner),
    gov: (inner: CborObj) => sum(3, inner),
    /** Not swapped: supplied, then the maximum. */
    txRefScriptsSizeTooBig: (size: number, max: number) => sum(6, U(size), U(max)),
    mempoolFailure: (text: string) => sum(7, new CborText(text)),
    /** NonEmpty list of key hashes, in withdrawal-map order. */
    wdrlNotDelegatedToDRep: (keyHashes: string[]) => sum(4, new CborArray([...keyHashes].sort().map(hexBytes))),
    /** The withdrawals map (reward account → amount) of the missing accounts. */
    withdrawalsMissingAccounts: (entries: Array<{ account: Uint8Array; amount: bigint }>) =>
        sum(8, new CborMap([...entries].sort((a, b) => compareRewardAccounts(a.account, b.account)).map((e) => ({ k: Bs(e.account), v: U(e.amount) })))),
};

export const ALL_INPUTS_SPENT = "All inputs are spent. Transaction has probably already been included";

// ───────────────────────── small-steps ordering ─────────────────────────

/**
 * One STS rule application: `fail` records a predicate's failures (a `Test` / `Validation`
 * with its errors in accumulation order), `sub` embeds a finished sub-rule. `failures` is the
 * rule's list exactly as small-steps holds it.
 */
export class RuleRun {
    private stored: CborObj[] = [];
    constructor(private readonly wrap: (inner: CborObj) => CborObj = (x) => x) {}
    fail(...errs: CborObj[]): void {
        if (errs.length) this.stored = [...errs.reverse(), ...this.stored];
    }
    /** Embed a finished sub-rule: each of its failures, wrapped, is prepended in turn. */
    sub(child: RuleRun): void {
        for (const f of child.stored) this.stored = [child.wrap(f), ...this.stored];
    }
    get failing(): boolean { return this.stored.length > 0; }
    get failures(): readonly CborObj[] { return this.stored; }
}

/** `[listLen 1, [6, [failure…]]]` — the HFC-wrapped Conway ApplyTxErr. */
export function applyTxErrCbor(failures: readonly CborObj[]): CborArray {
    return new CborArray([new CborArray([U(CONWAY_ERA_INDEX), new CborArray([...failures])])]);
}

/** MsgRejectTx bytes. */
export function rejectMessageBytes(failures: readonly CborObj[]): Uint8Array {
    return Cbor.encode(new CborArray([U(2), applyTxErrCbor(failures)])).toBuffer();
}

export const ACCEPT_MESSAGE = new Uint8Array([0x81, 0x01]);
