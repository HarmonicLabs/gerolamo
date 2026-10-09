/**
 * UTxO RPC predicate evaluation on mapped messages (Dolos' `watch.rs` semantics):
 *   - a pattern's empty fields match anything; all its set fields must match;
 *   - predicate = match ∧ ¬(any of `not`) ∧ (all of `all_of`) ∧ (any of `any_of`, when given);
 *   - a transaction "has" an address / "moves" an asset when one of its outputs or its resolved
 *     inputs does; `consumes` looks at resolved inputs only.
 */
import { cardano } from "@utxorpc/spec";
import { addressParts } from "../../ledger/utxoIndex";

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const set = (b: Uint8Array | undefined): b is Uint8Array => !!b && b.length > 0;

export function addressMatches(p: cardano.AddressPattern | undefined, address: Uint8Array): boolean {
    if (!p) return true;
    if (set(p.exactAddress) && !eq(p.exactAddress, address)) return false;
    if (set(p.paymentPart) || set(p.delegationPart)) {
        const parts = addressParts(address);
        if (set(p.paymentPart) && !(parts.payment && eq(parts.payment, p.paymentPart))) return false;
        if (set(p.delegationPart) && !(parts.delegation && eq(parts.delegation, p.delegationPart))) return false;
    }
    return true;
}

export function assetsMatch(p: cardano.AssetPattern | undefined, assets: cardano.Multiasset[]): boolean {
    if (!p || (!set(p.policyId) && !set(p.assetName))) return true;
    return assets.some((ma) => (!set(p.policyId) || eq(p.policyId, ma.policyId)) && (!set(p.assetName) || ma.assets.some((a) => eq(a.name, p.assetName))));
}

export function outputMatches(p: cardano.TxOutputPattern | undefined, o: cardano.TxOutput): boolean {
    if (!p) return true;
    return addressMatches(p.address, o.address) && assetsMatch(p.asset, o.assets);
}

/** UtxoPredicate over one output. */
export function utxoPredicateMatches(pred: { match?: { utxoPattern: { case: string | undefined; value?: unknown } }; not: any[]; allOf: any[]; anyOf: any[] } | undefined, o: cardano.TxOutput): boolean {
    if (!pred) return true;
    const m = pred.match?.utxoPattern;
    const matchOk = !m || m.case !== "cardano" || outputMatches(m.value as cardano.TxOutputPattern, o);
    if (!matchOk) return false;
    if (pred.not.some((p) => utxoPredicateMatches(p, o))) return false;
    if (!pred.allOf.every((p) => utxoPredicateMatches(p, o))) return false;
    if (pred.anyOf.length && !pred.anyOf.some((p) => utxoPredicateMatches(p, o))) return false;
    return true;
}

// ---------------------------------------------------------------- transactions

const credHashEq = (c: cardano.StakeCredential | undefined, h: Uint8Array) => !!c && (c.stakeCredential.case === "addrKeyHash" || c.stakeCredential.case === "scriptHash") && eq(c.stakeCredential.value, h);
const credPatternEq = (p: cardano.StakeCredential, a: cardano.StakeCredential | undefined) => p.stakeCredential.case === undefined || (!!a && a.stakeCredential.case === p.stakeCredential.case && eq(a.stakeCredential.value as Uint8Array, p.stakeCredential.value as Uint8Array));
const drepHashEq = (d: cardano.DRep | undefined, h: Uint8Array) => !!d && (d.drep.case === "addrKeyHash" || d.drep.case === "scriptHash") && eq(d.drep.value, h);

function certStakeCreds(c: cardano.Certificate["certificate"]): Array<cardano.StakeCredential | undefined> {
    switch (c.case) {
        case "stakeRegistration": case "stakeDeregistration": return [c.value];
        case "stakeDelegation": case "regCert": case "unregCert": case "voteDelegCert": case "stakeVoteDelegCert":
        case "stakeRegDelegCert": case "voteRegDelegCert": case "stakeVoteRegDelegCert": return [c.value.stakeCredential];
        case "authCommitteeHotCert": return [c.value.committeeColdCredential, c.value.committeeHotCredential];
        case "resignCommitteeColdCert": return [c.value.committeeColdCredential];
        case "regDrepCert": case "unregDrepCert": case "updateDrepCert": return [c.value.drepCredential];
        case "mirCert": return c.value.to.map((t) => t.stakeCredential);
        default: return [];
    }
}
function certPool(c: cardano.Certificate["certificate"]): Uint8Array | null {
    switch (c.case) {
        case "stakeDelegation": case "stakeVoteDelegCert": case "stakeRegDelegCert": case "stakeVoteRegDelegCert": return c.value.poolKeyhash;
        case "poolRegistration": return c.value.operator;
        case "poolRetirement": return c.value.poolKeyhash;
        default: return null;
    }
}
function certDrepMatches(c: cardano.Certificate["certificate"], h: Uint8Array): boolean {
    switch (c.case) {
        case "voteDelegCert": case "stakeVoteDelegCert": case "voteRegDelegCert": case "stakeVoteRegDelegCert": return drepHashEq(c.value.drep, h);
        case "regDrepCert": case "unregDrepCert": case "updateDrepCert": return credHashEq(c.value.drepCredential, h);
        default: return false;
    }
}

export function certificateMatches(p: cardano.CertificatePattern | undefined, certs: cardano.Certificate[]): boolean {
    const t = p?.certificateType;
    if (!t || t.case === undefined) return true;
    return certs.some(({ certificate: c }) => {
        switch (t.case) {
            case "stakeRegistration": return c.case === "stakeRegistration" && credPatternEq(t.value, c.value);
            case "stakeDeregistration": return c.case === "stakeDeregistration" && credPatternEq(t.value, c.value);
            case "stakeDelegation": return c.case === "stakeDelegation" && (!t.value.stakeCredential || credPatternEq(t.value.stakeCredential, c.value.stakeCredential)) && (!set(t.value.poolKeyhash) || eq(t.value.poolKeyhash, c.value.poolKeyhash));
            case "poolRegistration": return c.case === "poolRegistration" && (!set(t.value.operator) || eq(t.value.operator, c.value.operator)) && (!set(t.value.poolKeyhash) || eq(t.value.poolKeyhash, c.value.operator));
            case "poolRetirement": return c.case === "poolRetirement" && (!set(t.value.poolKeyhash) || eq(t.value.poolKeyhash, c.value.poolKeyhash)) && (t.value.epoch === 0n || t.value.epoch === c.value.epoch);
            case "anyStakeCredential": return certStakeCreds(c).some((x) => credHashEq(x, t.value));
            case "anyPoolKeyhash": { const pool = certPool(c); return !!pool && eq(pool, t.value); }
            case "anyDrep": return certDrepMatches(c, t.value);
            default: return false;
        }
    });
}

const resolvedInputs = (tx: cardano.Tx) => tx.inputs.map((i) => i.asOutput).filter((o): o is cardano.TxOutput => !!o);

export function txPatternMatches(p: cardano.TxPattern | undefined, tx: cardano.Tx): boolean {
    if (!p) return true;
    const ins = resolvedInputs(tx);
    if (p.hasAddress && !(ins.some((o) => addressMatches(p.hasAddress, o.address)) || tx.outputs.some((o) => addressMatches(p.hasAddress, o.address)))) return false;
    if (p.consumes && !ins.some((o) => outputMatches(p.consumes, o))) return false;
    if (p.produces && !tx.outputs.some((o) => outputMatches(p.produces, o))) return false;
    if (p.mintsAsset && !assetsMatch(p.mintsAsset, tx.mint)) return false;
    if (p.movesAsset && !(ins.some((o) => assetsMatch(p.movesAsset, o.assets)) || tx.outputs.some((o) => assetsMatch(p.movesAsset, o.assets)))) return false;
    if (p.hasCertificate && !certificateMatches(p.hasCertificate, tx.certificates)) return false;
    return true;
}

/** Watch / submit `TxPredicate` (both have the same shape: `match.chain` = cardano TxPattern). */
export interface AnyTxPredicate { match?: { chain: { case: string | undefined; value?: unknown } }; not: AnyTxPredicate[]; allOf: AnyTxPredicate[]; anyOf: AnyTxPredicate[] }

export function txPredicateMatches(pred: AnyTxPredicate | undefined, tx: cardano.Tx): boolean {
    if (!pred) return true;
    const m = pred.match?.chain;
    if (m && m.case === "cardano" && !txPatternMatches(m.value as cardano.TxPattern, tx)) return false;
    if (pred.not.some((p) => txPredicateMatches(p, tx))) return false;
    if (!pred.allOf.every((p) => txPredicateMatches(p, tx))) return false;
    if (pred.anyOf.length && !pred.anyOf.some((p) => txPredicateMatches(p, tx))) return false;
    return true;
}

/** Does a predicate look at inputs' contents (so inputs must be resolved to evaluate it)? */
export function needsResolvedInputs(pred: AnyTxPredicate | undefined): boolean {
    if (!pred) return false;
    const m = pred.match?.chain;
    if (m && m.case === "cardano") { const p = m.value as cardano.TxPattern; if (p.hasAddress || p.consumes || p.movesAsset) return true; }
    return [...pred.not, ...pred.allOf, ...pred.anyOf].some(needsResolvedInputs);
}
