/**
 * Stake-credential effects of certificates, as the ledger applies them:
 * in order, within a transaction and across the block.
 *
 * Pure functions so the rules can be tested without a database. The body
 * validator looks up the credentials a block touches, then runs the block's
 * certificates through `checkCertificateSequence`.
 *
 * Certificate type numbers follow `CertificateType` in cardano-ledger-ts
 * (Shelley 0–6, Conway 7–18).
 */
import type { GovCertModel, TypedCred } from "./governance/govTxDecode";

/**
 * `StakeKeyHasNonZeroAccountBalanceDELEG` reads our reward balances, which carry the same caveat
 * as the withdrawal-amount check (rules/txRules.ts `WITHDRAWALS_STRICT`): a reward computed a few
 * lovelace off would reject a real deregistration after a full withdrawal. Strict when the view's
 * balances are exact (`CertLedgerView.balancesExact`: lmdb mode on a snapshot-imported store, bug 274);
 * this constant forces it everywhere.
 */
export const STAKE_BALANCE_PREDICATE_STRICT = false;

export interface CertStakeEffect {
    /** False for a type we do not know: the block is rejected. */
    known: boolean;
    /** Registers the stake credential (fails if already registered). */
    registers: boolean;
    /** Deregisters the stake credential (fails if not registered). */
    deregisters: boolean;
    /** Needs an already-registered stake credential. */
    requiresRegistered: boolean;
    /** Sets the credential's pool delegation. */
    delegatesToPool: boolean;
}

const NONE: CertStakeEffect = { known: true, registers: false, deregisters: false, requiresRegistered: false, delegatesToPool: false };

export function certStakeEffect(certType: number): CertStakeEffect {
    switch (certType) {
        case 0: // StakeRegistration
        case 7: // RegistrationDeposit (Conway reg_cert)
        case 12: // VoteRegistrationDeleg (register + DRep delegation)
            return { ...NONE, registers: true };
        case 11: // StakeRegistrationDeleg (register + pool delegation)
        case 13: // StakeVoteRegistrationDeleg (register + pool + DRep delegation)
            return { ...NONE, registers: true, delegatesToPool: true };
        case 1: // StakeDeRegistration
        case 8: // UnRegistrationDeposit (Conway unreg_cert)
            return { ...NONE, deregisters: true };
        case 2: // StakeDelegation
        case 10: // StakeVoteDeleg
            return { ...NONE, requiresRegistered: true, delegatesToPool: true };
        case 9: // VoteDeleg (DRep only)
            return { ...NONE, requiresRegistered: true };
        case 3: // PoolRegistration
        case 4: // PoolRetirement
        case 5: // GenesisKeyDelegation (pre-Conway)
        case 6: // MoveInstantRewards (pre-Conway)
        case 14: // AuthCommitteeHot
        case 15: // ResignCommitteeCold
        case 16: // RegistrationDrep
        case 17: // UnRegistrationDrep
        case 18: // UpdateDrep
            return NONE; // no stake-credential state checked here
        default:
            return { ...NONE, known: false };
    }
}

export interface CertView {
    certType: number;
    /** Stake credential hash (hex), when the certificate carries one. */
    credHex: string | null;
    /**
     * Credential type: 0 = key hash, 1 = script hash. The ledger keys stake
     * credentials by (type, hash): a script credential and a key credential
     * with the same 28 bytes are two different accounts (preprod slot
     * 22056654 registers the script twin of a key registered at 22056832).
     */
    credType: number | null;
    /** Pool key hash (hex) for pool delegations. */
    poolHex: string | null;
}

/** Map key for a stake credential: `${type}:${hash}`. */
export function credKey(credType: number | null | undefined, credHex: string): string {
    return `${credType ?? 0}:${credHex.toLowerCase()}`;
}

export type CertSequenceResult = { ok: true } | { ok: false; reason: string };

/**
 * Apply `certs` in order against the registered set / delegation map, which
 * start as the state before the block and are updated as certificates take
 * effect. A registration followed by a delegation of the same key in one tx
 * (the normal wallet flow) is valid; a second registration is not.
 */
export function checkCertificateSequence(
    certs: readonly CertView[],
    registered: Set<string>,
    delegated: Map<string, string>,
): CertSequenceResult {
    for (const cert of certs) {
        const fx = certStakeEffect(cert.certType);
        if (!fx.known) return { ok: false, reason: `Unknown certificate type: ${cert.certType}` };
        const touchesStake = fx.registers || fx.deregisters || fx.requiresRegistered;
        if (!touchesStake) continue;
        if (!cert.credHex) return { ok: false, reason: `Certificate type ${cert.certType} without a stake credential` };
        const key = credKey(cert.credType, cert.credHex);

        if (fx.registers) {
            if (registered.has(key)) return { ok: false, reason: `Stake credential already registered: ${key}` };
            registered.add(key);
        } else if (fx.deregisters) {
            if (!registered.has(key)) return { ok: false, reason: `Stake credential not registered: ${key}` };
            registered.delete(key);
            delegated.delete(key);
        } else if (fx.requiresRegistered) {
            if (!registered.has(key) && !delegated.has(key)) {
                return { ok: false, reason: `Cannot delegate unregistered stake credential: ${key}` };
            }
        }
        if (fx.delegatesToPool) delegated.set(key, cert.poolHex ?? "");
    }
    return { ok: true };
}

/** Credentials (hex) whose registration / delegation state the block's certificates read or write. */
export function stakeCredentialsTouched(certs: readonly CertView[]): Array<{ hex: string; type: number }> {
    const out = new Map<string, { hex: string; type: number }>();
    for (const c of certs) {
        const fx = certStakeEffect(c.certType);
        if ((fx.registers || fx.deregisters || fx.requiresRegistered) && c.credHex) {
            const type = c.credType ?? 0;
            out.set(credKey(type, c.credHex), { hex: c.credHex.toLowerCase(), type });
        }
    }
    return Array.from(out.values());
}

// ───────────────────────────── Conway DELEG / POOL (ledger-state checks) ─────────────────────────────
//
// cardano-ledger-conway 1.22.1 (cardano-node 11.0.1) `Rules/Deleg.hs` and the Shelley `Rules/Pool.hs`
// it embeds, for the certificates of one phase-2-valid transaction in order. The value balance of
// the deposits is the UTXO rule's (rules/txRules.ts); these are the per-certificate predicates.
// A view answer of `null` means "not known here" and skips that predicate (the replay has no
// reward balances, for instance), never a failure.


/** Account, pool and DRep facts the DELEG / POOL / GOVCERT predicates read (state before the certificate). */
export interface CertLedgerView {
    accountRegistered(cred: TypedCred): boolean | null;
    /** The deposit the account paid at registration (the refund it is owed), when tracked. */
    accountDeposit(cred: TypedCred): bigint | null;
    /** Reward balance, when tracked. */
    accountBalance(cred: TypedCred): bigint | null;
    /** Are the reward balances (and the treasury) exact? Absent = no: their predicates report, with `why`. */
    balancesExact?(): { exact: boolean; why: string };
    poolRegistered(poolId: string): boolean | null;
    /** VRF key hash of a registered pool (for the protocol-11 duplicate-VRF rule), null when unknown. */
    poolVrf(poolId: string): string | null;
    /** Every VRF key hash registered (current and future pool parameters), null when unknown. */
    registeredVrfs(): Set<string> | null;
    drepRegistered(cred: TypedCred): boolean | null;
}

/** Parameters the certificate predicates read (the epoch's protocol parameters). */
export interface CertRuleParams {
    protocolMajor: number;
    protocolMinor: number;
    keyDeposit: bigint;
    minPoolCost: bigint;
    eMax: number;
    /** 0 testnet, 1 mainnet. */
    networkId: number;
    epoch: number;
}

/** State changes a certificate makes, for the next certificate / transaction of the block. */
export interface CertEffects {
    registerAccount?: { cred: TypedCred; deposit: bigint };
    unregisterAccount?: TypedCred;
    registerPool?: { pool: string; vrf: string };
}

/**
 * DELEG and POOL predicate failures of one certificate, named after the ledger's constructors
 * (the pre-protocol-11 `IncorrectDepositDELEG` for a wrong deposit or refund, the protocol-11
 * `DepositIncorrectDELEG` / `RefundIncorrectDELEG`). Types 14–18 are GOVCERT (governance/govRules.ts).
 */
export function conwayDelegPoolFailures(c: GovCertModel, pp: CertRuleParams, v: CertLedgerView): { failures: string[]; reports: string[]; effects: CertEffects } {
    const failures: string[] = [], reports: string[] = [], effects: CertEffects = {};
    const pv11 = pp.protocolMajor > 10, bootstrap = pp.protocolMajor === 9;
    const depositCheck = (deposit: bigint) => {
        if (deposit !== pp.keyDeposit) failures.push(pv11 ? `DELEG DepositIncorrectDELEG supplied ${deposit} expected ${pp.keyDeposit}` : `DELEG IncorrectDepositDELEG ${deposit}`);
    };
    const notRegistered = (cred: TypedCred) => { if (v.accountRegistered(cred) === true) failures.push(`DELEG StakeKeyRegisteredDELEG ${cred}`); };
    const delegateeRegistered = () => {
        if (c.pool != null && (c.type === 2 || c.type === 10 || c.type === 11 || c.type === 13) && v.poolRegistered(c.pool) === false) failures.push(`DELEG DelegateeStakePoolNotRegisteredDELEG ${c.pool}`);
        if (c.drep?.kind === "cred" && (c.type === 9 || c.type === 10 || c.type === 12 || c.type === 13) && !bootstrap && v.drepRegistered(c.drep.cred) === false) failures.push(`DELEG DelegateeDRepNotRegisteredDELEG ${c.drep.cred}`);
    };
    switch (c.type) {
        case 0: case 7: {
            if (c.type === 7) depositCheck(c.coin ?? 0n);
            notRegistered(c.cred!);
            effects.registerAccount = { cred: c.cred!, deposit: pp.keyDeposit };
            break;
        }
        case 1: case 8: {
            const reg = v.accountRegistered(c.cred!);
            if (c.type === 8 && reg !== false) {
                const paid = v.accountDeposit(c.cred!);
                const refund = c.coin ?? 0n;
                if (paid != null && refund !== paid) failures.push(pv11 ? `DELEG RefundIncorrectDELEG supplied ${refund} expected ${paid}` : `DELEG IncorrectDepositDELEG ${refund}`);
                else if (paid == null && refund !== pp.keyDeposit) reports.push(`DELEG refund ${refund} differs from the current key deposit ${pp.keyDeposit} (paid deposit not tracked)`);
            }
            if (reg !== false) {
                const bal = v.accountBalance(c.cred!);
                if (bal != null && bal !== 0n) {
                    const ex = v.balancesExact?.();
                    if (STAKE_BALANCE_PREDICATE_STRICT || ex?.exact) failures.push(`DELEG StakeKeyHasNonZeroAccountBalanceDELEG ${bal}`);
                    else reports.push(`DELEG StakeKeyHasNonZeroAccountBalanceDELEG ${bal} (report-only: ${ex?.why || "reward balances not proven exact"})`);
                }
            }
            if (reg === false) failures.push(`DELEG StakeKeyNotRegisteredDELEG ${c.cred}`);
            effects.unregisterAccount = c.cred!;
            break;
        }
        case 2: case 9: case 10: {
            delegateeRegistered();
            if (v.accountRegistered(c.cred!) === false) failures.push(`DELEG StakeKeyNotRegisteredDELEG ${c.cred}`);
            break;
        }
        case 11: case 12: case 13: {
            depositCheck(c.coin ?? 0n);
            notRegistered(c.cred!);
            delegateeRegistered();
            effects.registerAccount = { cred: c.cred!, deposit: pp.keyDeposit };
            break;
        }
        case 3: {
            const r = c.poolReg!;
            if (pp.protocolMajor > 4 && r.rewardAccount.network !== pp.networkId) failures.push(`POOL WrongNetworkPOOL supplied ${r.rewardAccount.network} expected ${pp.networkId} ${c.pool}`);
            if (r.metadataHashLen != null && r.metadataHashLen > 32) failures.push(`POOL PoolMedataHashTooBig ${c.pool} ${r.metadataHashLen}`);
            if (r.cost < pp.minPoolCost) failures.push(`POOL StakePoolCostTooLowPOOL supplied ${r.cost} expected ${pp.minPoolCost}`);
            if (pv11) {
                const vrfs = v.registeredVrfs();
                const registered = v.poolRegistered(c.pool!);
                if (vrfs && registered === false && vrfs.has(r.vrf)) failures.push(`POOL VRFKeyHashAlreadyRegistered ${c.pool} ${r.vrf}`);
                if (vrfs && registered === true && v.poolVrf(c.pool!) !== r.vrf && vrfs.has(r.vrf)) failures.push(`POOL VRFKeyHashAlreadyRegistered ${c.pool} ${r.vrf}`);
            }
            effects.registerPool = { pool: c.pool!, vrf: r.vrf };
            break;
        }
        case 4: {
            if (v.poolRegistered(c.pool!) === false) failures.push(`POOL StakePoolNotRegisteredOnKeyPOOL ${c.pool}`);
            const e = c.epoch ?? 0, limit = pp.epoch + pp.eMax;
            if (!(pp.epoch < e && e <= limit)) failures.push(`POOL StakePoolRetirementWrongEpochPOOL supplied ${e} expected > ${pp.epoch} and <= ${limit}`);
            break;
        }
        case 5: case 6:
            failures.push(`certificate type ${c.type} is not valid in Conway`);
            break;
    }
    return { failures, reports, effects };
}
