/**
 * Who must have signed a Shelley+ transaction (cardano-ledger `witsVKeyNeeded`)
 * and which scripts must be provided (`scriptsNeeded`):
 *
 *   inputs / collateral  — payment credential of every spent output
 *   certificates         — stake credential (all but plain stake registration),
 *                          pool operator + owners on registration, pool key on
 *                          retirement, genesis key on genesis delegation,
 *                          DRep / committee credentials on Conway certs
 *   withdrawals          — reward account credential
 *   required_signers     — listed key hashes
 *   votes                — voter key (DRep / CC hot / SPO cold)
 *   mint                 — every policy id is a script
 */
import { Address, ByronAddress, CredentialType, VoterKind } from "@harmoniclabs/cardano-ledger-ts";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { utxoRefOf } from "./resolvedUtxo";

export interface RequiredWitnesses {
    keyHashes: Set<string>;
    scriptHashes: Set<string>;
    /** Byron address roots of spent bootstrap outputs (satisfied by bootstrap witnesses). */
    bootstrapRoots: Set<string>;
    /** Inputs whose address could not be parsed or resolved. */
    problems: string[];
}

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

/** Parse a stored address; null when it is not a Shelley or Byron address. */
/** Parsed-address cache: the same address strings recur across a block's inputs and outputs; parsing bech32/base58 through ledger-ts cost ~5 % of the apply thread. */
const parsedAddressCache = new Map<string, Address | ByronAddress | null>();
const PARSED_ADDRESS_CACHE_MAX = 20_000;

export function parseStoredAddress(addr: string): Address | ByronAddress | null {
    if (!addr) return null;
    const hit = parsedAddressCache.get(addr);
    if (hit !== undefined) return hit;
    const parsed = parseStoredAddressUncached(addr);
    if (parsedAddressCache.size >= PARSED_ADDRESS_CACHE_MAX) parsedAddressCache.delete(parsedAddressCache.keys().next().value!);
    parsedAddressCache.set(addr, parsed);
    return parsed;
}

function parseStoredAddressUncached(addr: string): Address | ByronAddress | null {
    try {
        if (!addr) return null;
        if (addr.startsWith("addr") || addr.startsWith("stake")) {
            try {
                return Address.fromString(addr) as Address | ByronAddress;
            } catch {
                return lenientShelleyAddress(addr);
            }
        }
        if (ByronAddress.isValid(addr)) return ByronAddress.fromBase58(addr);
        return Address.fromString(addr) as Address | ByronAddress;
    } catch {
        return null;
    }
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Bytes(addr: string): Uint8Array | null {
    const i = addr.lastIndexOf("1");
    if (i <= 0) return null;
    const data = addr.slice(i + 1, -6).toLowerCase();
    let acc = 0, bits = 0;
    const out: number[] = [];
    for (const c of data) {
        const v = BECH32.indexOf(c);
        if (v < 0) return null;
        acc = (acc << 5) | v;
        bits += 5;
        while (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

/**
 * Shelley address decoded regardless of the network nibble. The chain holds
 * outputs whose header carries a network id other than 0/1 (preprod slot
 * 13428506: `addr_test1p…`); ledger-ts rejects them, but the credentials sit at
 * the usual offsets, so the header is normalised to the address's own network
 * and parsed by ledger-ts as usual.
 */
export function lenientShelleyAddress(addr: string): Address | null {
    const bytes = bech32Bytes(addr);
    if (!bytes || bytes.length < 29) return null;
    const type = bytes[0]! >> 4;
    if (type > 7) return null;
    const fixed = new Uint8Array(bytes);
    fixed[0] = (type << 4) | (addr.startsWith("addr_test") ? 0 : 1);
    try {
        return Address.fromBytes(fixed) as Address;
    } catch {
        return null;
    }
}

function addCredential(out: RequiredWitnesses, cred: any): void {
    if (!cred) return;
    const type = cred.type;
    const h = hex(cred.hash);
    if (!h) return;
    if (type === CredentialType.Script || type === "script" || type === 1) out.scriptHashes.add(h);
    else out.keyHashes.add(h);
}

function addAddressCredential(out: RequiredWitnesses, address: string, ref: string): void {
    const a = parseStoredAddress(address);
    if (!a) {
        out.problems.push(`input ${ref}: unparseable address ${address.slice(0, 20)}`);
        return;
    }
    if (a instanceof ByronAddress) {
        out.bootstrapRoots.add(hex(Buffer.from(a.rootHash).toString("hex")));
        return;
    }
    addCredential(out, a.paymentCreds);
}

function addStakeAddress(out: RequiredWitnesses, sa: any): void {
    if (!sa) return;
    const creds = sa.credentials ?? sa;
    const h = hex(creds?.hash ?? creds);
    if (!h) return;
    const isScript = sa.type === "script" || (creds?.constructor?.name ?? "").includes("Validator");
    (isScript ? out.scriptHashes : out.keyHashes).add(h);
}

export function requiredWitnesses(txBody: any, resolved: Map<string, ResolvedUtxo>): RequiredWitnesses {
    const out: RequiredWitnesses = { keyHashes: new Set(), scriptHashes: new Set(), bootstrapRoots: new Set(), problems: [] };

    for (const list of [txBody.inputs, txBody.collateralInputs] as any[][]) {
        for (const input of list ?? []) {
            const ref = utxoRefOf(input);
            if (!ref) continue;
            const u = resolved.get(ref);
            if (!u) continue; // "bad inputs" is its own rule
            addAddressCredential(out, u.address, ref);
        }
    }

    for (const cert of (txBody.certs ?? []) as any[]) {
        const t = Number(cert.certType);
        switch (t) {
            case 0: // StakeRegistration: no witness (Shelley)
                break;
            case 1: case 2: case 7: case 8: case 9: case 10: case 11: case 12: case 13:
                addCredential(out, cert.stakeCredential);
                break;
            case 3: { // PoolRegistration
                const pp = cert.poolParams ?? {};
                out.keyHashes.add(hex(pp.operator));
                for (const o of (pp.owners ?? []) as any[]) out.keyHashes.add(hex(o));
                break;
            }
            case 4: // PoolRetirement
                out.keyHashes.add(hex(cert.poolHash));
                break;
            case 5: // GenesisKeyDelegation: signed by the genesis key
                out.keyHashes.add(hex(cert.genesisHash));
                break;
            case 6: // MIR: genesis delegates' quorum, checked elsewhere
                break;
            case 14: case 15:
                addCredential(out, cert.coldCredential);
                break;
            case 16: case 17: case 18:
                addCredential(out, cert.drepCredential);
                break;
            default:
                break;
        }
    }

    const wdMap = txBody.withdrawals?.map ?? [];
    for (const w of wdMap as any[]) addStakeAddress(out, w.rewardAccount);

    for (const k of (txBody.requiredSigners ?? []) as any[]) out.keyHashes.add(hex(k));

    for (const entry of (txBody.votingProcedures?.procedures ?? []) as any[]) {
        const v = entry.voter;
        if (!v) continue;
        const h = hex(v.hash);
        if (v.kind === VoterKind.ConstitutionalCommitteScript || v.kind === VoterKind.DRepScript) out.scriptHashes.add(h);
        else out.keyHashes.add(h);
    }

    const mint = txBody.mint;
    if (mint && Array.isArray(mint.map)) {
        for (const { policy } of mint.map as any[]) {
            const p = hex(policy);
            if (p) out.scriptHashes.add(p);
        }
    }
    out.scriptHashes.delete("");
    out.keyHashes.delete("");
    return out;
}
