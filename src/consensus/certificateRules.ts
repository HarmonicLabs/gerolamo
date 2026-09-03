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
    /** Pool key hash (hex) for pool delegations. */
    poolHex: string | null;
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
        const key = cert.credHex;
        if (!key) return { ok: false, reason: `Certificate type ${cert.certType} without a stake credential` };

        if (fx.registers) {
            if (registered.has(key)) return { ok: false, reason: `Stake key already registered: ${key}` };
            registered.add(key);
        } else if (fx.deregisters) {
            if (!registered.has(key)) return { ok: false, reason: `Stake key not registered: ${key}` };
            registered.delete(key);
            delegated.delete(key);
        } else if (fx.requiresRegistered) {
            if (!registered.has(key) && !delegated.has(key)) {
                return { ok: false, reason: `Cannot delegate unregistered stake key: ${key}` };
            }
        }
        if (fx.delegatesToPool) delegated.set(key, cert.poolHex ?? "");
    }
    return { ok: true };
}

/** Credentials (hex) whose registration / delegation state the block's certificates read or write. */
export function stakeCredentialsTouched(certs: readonly CertView[]): string[] {
    const out = new Set<string>();
    for (const c of certs) {
        const fx = certStakeEffect(c.certType);
        if ((fx.registers || fx.deregisters || fx.requiresRegistered) && c.credHex) out.add(c.credHex);
    }
    return Array.from(out);
}
