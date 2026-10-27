import { settings } from "../config/settings";
import {
    AllegraHeader,
    AlonzoHeader,
    BabbageHeader,
    ConwayHeader,
    DijkstraHeader,
    isIAllegraHeader,
    isIAlonzoHeader,
    isIBabbageHeader,
    isIConwayHeader,
    isIMaryHeader,
    isIShelleyHeader,
    type IVrfCert,
    type KesPubKey,
    type KesSignature,
    MaryHeader,
    MultiEraHeader,
    PoolKeyHash,
    PublicKey,
    ShelleyHeader,
    VrfCert,
} from "@harmoniclabs/cardano-ledger-ts";
import { isByronEra } from "./blockHeaderParser";
import { praosVrfInput, tpraosVrfInput } from "./vrfInputs";
import { vrf03Verify } from "./fastVrf";
import { validateByronHeader } from "./ByronHeaderValidator";
import {
    blake2b_224,
    blake2b_256,
    verifyEd25519Signature_sync,
    VrfProof03,
} from "@harmoniclabs/crypto";
import {
    concatUint8Array,
    fromHex,
    toHex,
    uint8ArrayEq,
    writeBigUInt64BE,
} from "@harmoniclabs/uint8array-utils";
import { PoolOperationalCert } from "@harmoniclabs/cardano-ledger-ts";
import { BigDecimal, expCmp, ExpOrd } from "@harmoniclabs/cardano-math-ts";
import { Cbor } from "@harmoniclabs/cbor";
import { setEd25519Verify, verify as tsKesVerify } from "@harmoniclabs/kes";
import { ed25519Verify, verifyEd25519Fast } from "./fastEd25519";

// KES leaf verification is one raw ed25519 verify; give kes-ts the fast pure-TS
// implementation (module-level so the worker threads get it too).
setEd25519Verify(ed25519Verify());
import { getShelleyGenesisConfig } from "../utils/paths";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import { logger } from "../utils/logger";
// import { RawNewEpochState } from "../rawNES"; // TODO: Add when RawNewEpochState is implemented

/**
 * KES header verify — pure TS @harmoniclabs/kes (Sum6, 448-byte).
 * Dual-run soak: 2000 real preprod headers, 0 divergences vs wasm-kes.
 * Soak scripts: scripts/kes-soak-chunks.mjs, scripts/kes-soak-dualrun.mjs
 */
function verifyKesCrypto(
    signature: KesSignature,
    kesPeriod: number,
    pubKey: KesPubKey,
    body: Uint8Array,
): boolean {
    return tsKesVerify(signature, kesPeriod, pubKey, body);
}

let genesisCache: ShelleyGenesisConfig | null = null;

/**
 * True when the header issuer is one of the Shelley genesis delegates.
 * genDelegs maps genesisKeyHash → { delegate: blake2b-224(delegate cold vkey), vrf }.
 * The header carries the delegate's 32-byte cold vkey, so hash it and compare
 * against the `delegate` values (not the map keys).
 */
function isGenesisDelegateIssuer(
    issuerPubKey: PoolKeyHash,
    genesis: ShelleyGenesisConfig,
): boolean {
    const vkey = issuerPubKey.toBuffer();
    if (!(vkey instanceof Uint8Array) || vkey.length !== 32) return false;
    const issuerKeyHash = toHex(blake2b_224(vkey));
    for (const entry of Object.values(genesis.genDelegs ?? {})) {
        const delegate = (entry as { delegate?: unknown })?.delegate;
        if (typeof delegate === "string" && delegate.toLowerCase() === issuerKeyHash) {
            return true;
        }
    }
    return false;
}

/** --trace-headers: log every passed header (nine lines per header, from every hot peer — 22 000 lines a minute on a fast sync). */
const headerTrace = (): boolean => settings().traceHeaders;

const CERTIFIED_NATURAL_MAX = BigDecimal.fromString(
    "1157920892373161954235709850086879078532699846656405640394575840079131296399360000000000000000000000000000000000",
);

async function getCachedShelleyGenesis(
    config: any,
): Promise<ShelleyGenesisConfig | null> {
    if (genesisCache) return genesisCache;
    try {
        genesisCache = await getShelleyGenesisConfig(config);
        return genesisCache;
    } catch (error) {
        logger.error("Failed to load Shelley genesis config:", error);
        return null;
    }
}

export class ValidatePostBabbageHeader {
    // private lState: RawNewEpochState; // TODO: Add when RawNewEpochState is implemented

    constructor() {
        // this.lState = RawNewEpochState.init();
    }

    private verifyKnownLeader(
        issuerPubKey: PoolKeyHash,
        genesis: ShelleyGenesisConfig,
    ): boolean {
        return isGenesisDelegateIssuer(issuerPubKey, genesis);
    }

    private verifyLeaderEligibility(
        asc: BigDecimal,
        leaderRelativeStake: BigDecimal,
        certifiedLeaderVrf: bigint,
    ): boolean {
        const denom = BigDecimal.sub(
            CERTIFIED_NATURAL_MAX,
            BigDecimal.fromBigint(certifiedLeaderVrf),
        );
        const recipQ = BigDecimal.div(CERTIFIED_NATURAL_MAX, denom);
        const c = BigDecimal.sub(BigDecimal.fromBigint(1n), asc).ln();
        const x = BigDecimal.mul(leaderRelativeStake, c).neg();

        return expCmp(x, 1000n, 3n, recipQ).estimation === ExpOrd.LT;
    }

    private verifyKESSignature(
        slotKESPeriod: bigint,
        opcertKESPeriod: bigint,
        body: Uint8Array,
        pubKey: KesPubKey,
        signature: KesSignature,
        maxKESEvo: bigint,
    ): boolean {
        if (opcertKESPeriod > slotKESPeriod) return false;
        if (slotKESPeriod >= opcertKESPeriod + maxKESEvo) return false;

        const kesPeriod = Number(slotKESPeriod - opcertKESPeriod);
        if (kesPeriod < 0) return false;

        return verifyKesCrypto(signature, kesPeriod, pubKey, body);
    }

    private verifyOpCertError(
        cert: PoolOperationalCert,
        issuer: PublicKey,
    ): boolean {
        return verifyEd25519Fast(
            cert.signature,
            concatUint8Array(
                cert.kesPubKey,
                fromHex(cert.sequenceNumber.toString(16).padStart(16, "0")),
                fromHex(cert.kesPeriod.toString(16).padStart(16, "0")),
            ),
            issuer.toBuffer(),
        );
    }

    private verifyVrfProof(
        input: Uint8Array,
        output: Uint8Array,
        leaderPubKey: Uint8Array,
        cert: IVrfCert | VrfCert,
        era: "pre-babbage" | "post-babbage",
    ): boolean {
        // ECVRF-ED25519-SHA512-Elligator2 (draft-03): the proof must verify under the
        // pool's VRF key for this slot's input, and the header's 64-byte output must be
        // the proof's hash. Both eras carry the raw output (TPraos and Praos alike).
        // Checked against real preprod headers with their epoch nonces (Shelley epoch 4
        // and Conway epoch 310) before this was switched on.
        void era;
        // Fast draft-03 verifier (noble ed25519); cross-checked against the pure-BigInt
        // reference on stored preprod headers (scripts/verify-fast-vrf.ts, 600/600 agree).
        const proofBytes: Uint8Array = (cert.proof as any)?.toBuffer?.() ?? (cert.proof as Uint8Array);
        const computed = vrf03Verify(leaderPubKey, input, proofBytes);
        if (!computed) return false;
        return uint8ArrayEq(computed, output);
    }

    private getVrfInput(slot: bigint, nonce: Uint8Array): Uint8Array {
        return praosVrfInput(slot, nonce);
    }

    private biguintToU64BE(n: bigint): Uint8Array {
        const result = new Uint8Array(8);
        writeBigUInt64BE(result, n, 0);
        return result;
    }

    private getEraHeader(
        h: MultiEraHeader,
    ): BabbageHeader | ConwayHeader | DijkstraHeader | null {
        if (h.era < 6) return null;
        if (h.era === 6 && !isIBabbageHeader(h.header)) {
            throw new Error("Invalid Babbage header for era 6");
        }
        if (h.era === 7 && !isIConwayHeader(h.header)) {
            throw new Error("Invalid Conway header for era 7");
        }
        // Dijkstra (bug 425): the Praos header plus the Leios fields; VRF, KES and opcert rules are unchanged.
        if (h.era === 8 && !(h.header instanceof DijkstraHeader)) {
            throw new Error("Invalid Dijkstra header for era 8");
        }
        if (h.era > 8) return null;
        return h.header as BabbageHeader | ConwayHeader | DijkstraHeader;
    }

    public async validate(
        h: MultiEraHeader,
        nonce: Uint8Array,
        config: any,
        options?: HeaderValidationOptions,
    ): Promise<boolean | null> {
        const genesis = await getCachedShelleyGenesis(config);
        if (!genesis) return false;

        const header = this.getEraHeader(h);
        if (
            !(header instanceof BabbageHeader ||
                header instanceof ConwayHeader ||
                header instanceof DijkstraHeader) || header === null
        ) {
            return null;
        }

        const activeSlotCoeff = genesis.activeSlotsCoeff;
        const maxKesEvo = BigInt(genesis.maxKESEvolutions);
        const slotsPerKESPeriod = BigInt(genesis.slotsPerKESPeriod);

        const issuer = new PoolKeyHash(header.body.issuerPubKey);
        const isKnownLeader = this.verifyKnownLeader(issuer, genesis);

        const leaderVrfOut = concatUint8Array(
            Buffer.from("L"),
            header.body.getLeaderVrfOutput(),
        );

        const vrfInput = this.getVrfInput(header.body.slot, nonce);
        const correctProof = options?.skipVrf ? true : this.verifyVrfProof(
            vrfInput,
            header.body.vrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.vrfResult,
            "post-babbage",
        );
        // logger.debug("correctProof:", correctProof);

        // Stake calculation using genesis as fallback
        let individualStake = 0n;
        const totalActiveStake = BigInt(Object.keys(genesis.genDelegs).length);

        if (isKnownLeader) {
            individualStake = 1n;
        }

        let stakeRatio: BigDecimal;
        if (totalActiveStake === 0n) {
            stakeRatio = BigDecimal.from(0);
        } else {
            stakeRatio = BigDecimal.from(individualStake).div(
                BigDecimal.from(totalActiveStake),
            );
        }

        const verifyLeaderStake = this.verifyLeaderEligibility(
            BigDecimal.from(activeSlotCoeff),
            stakeRatio,
            BigInt(`0x${toHex(leaderVrfOut)}`),
        );

        const verifyOpCertValidity = this.verifyOpCertError(
            header.body.opCert,
            new PublicKey(header.body.issuerPubKey),
        );

        // ledger-ts cbor v2 CborObj is not a gerolamo cbor v1 instance — use body bytes directly
        const headerBodyBytes = header.body.toCborBytes();

        const verifyKES = this.verifyKESSignature(
            header.body.slot / slotsPerKESPeriod,
            header.body.opCert.kesPeriod,
            headerBodyBytes,
            header.body.opCert.kesPubKey,
            header.kesSignature,
            maxKesEvo,
        );

        const issuerHex = toHex(issuer.toCborBytes());
        const passed = correctProof && verifyLeaderStake &&
            verifyOpCertValidity && verifyKES;
        // Per-header result at debug: at info it was half of a 4 GB log (10 lines per header,
        // every verifier re-delivers every header). Failures are reported by the caller.
        if (!passed || headerTrace()) (passed ? logger.debug : logger.info).call(logger,
            `Header validation ${
                passed ? "PASSED" : "FAILED"
            } era=${h.era} slot=${header.body.slot}`,
            {
                issuerHex,
                isKnownLeader,
                correctProof,
                verifyLeaderStake,
                verifyOpCertValidity,
                verifyKES,
                passed,
            },
        );

        // Slot leadership (overlay schedule, pool registration, VRF key binding and
        // the stake threshold) is decided on the main thread with ledger state
        // (rules/leaderCheck.ts); `verifyLeaderStake` above is only logged.
        void verifyLeaderStake;
        return correctProof && verifyOpCertValidity && verifyKES;
    }
}

export class ValidatePreBabbageHeader {
    // private lState: RawNewEpochState; // TODO: Add when RawNewEpochState is implemented

    constructor() {
        // this.lState = RawNewEpochState.init();
    }

    private verifyKnownLeader(
        issuerPubKey: PoolKeyHash,
        genesis: ShelleyGenesisConfig,
    ): boolean {
        return isGenesisDelegateIssuer(issuerPubKey, genesis);
    }

    private verifyLeaderEligibility(
        asc: BigDecimal,
        leaderRelativeStake: BigDecimal,
        certifiedLeaderVrf: bigint,
    ): boolean {
        const denom = BigDecimal.sub(
            CERTIFIED_NATURAL_MAX,
            BigDecimal.fromBigint(certifiedLeaderVrf),
        );
        const recipQ = BigDecimal.div(CERTIFIED_NATURAL_MAX, denom);
        const c = BigDecimal.sub(BigDecimal.fromBigint(1n), asc).ln();
        const x = BigDecimal.mul(leaderRelativeStake, c).neg();

        return expCmp(x, 1000n, 3n, recipQ).estimation === ExpOrd.LT;
    }

    private verifyKESSignature(
        slotKESPeriod: bigint,
        opcertKESPeriod: bigint,
        body: Uint8Array,
        pubKey: KesPubKey,
        signature: KesSignature,
        maxKESEvo: bigint,
    ): boolean {
        if (opcertKESPeriod > slotKESPeriod) return false;
        if (slotKESPeriod >= opcertKESPeriod + maxKESEvo) return false;

        const kesPeriod = Number(slotKESPeriod - opcertKESPeriod);
        if (kesPeriod < 0) return false;

        return verifyKesCrypto(signature, kesPeriod, pubKey, body);
    }

    private verifyOpCertError(
        cert: PoolOperationalCert,
        issuer: PublicKey,
    ): boolean {
        return verifyEd25519Fast(
            cert.signature,
            concatUint8Array(
                cert.kesPubKey,
                fromHex(cert.sequenceNumber.toString(16).padStart(16, "0")),
                fromHex(cert.kesPeriod.toString(16).padStart(16, "0")),
            ),
            issuer.toBuffer(),
        );
    }

    private verifyVrfProof(
        input: Uint8Array,
        output: Uint8Array,
        leaderPubKey: Uint8Array,
        cert: IVrfCert | VrfCert,
        era: "pre-babbage" | "post-babbage",
    ): boolean {
        // ECVRF-ED25519-SHA512-Elligator2 (draft-03): the proof must verify under the
        // pool's VRF key for this slot's input, and the header's 64-byte output must be
        // the proof's hash. Both eras carry the raw output (TPraos and Praos alike).
        // Checked against real preprod headers with their epoch nonces (Shelley epoch 4
        // and Conway epoch 310) before this was switched on.
        void era;
        // Fast draft-03 verifier (noble ed25519); cross-checked against the pure-BigInt
        // reference on stored preprod headers (scripts/verify-fast-vrf.ts, 600/600 agree).
        const proofBytes: Uint8Array = (cert.proof as any)?.toBuffer?.() ?? (cert.proof as Uint8Array);
        const computed = vrf03Verify(leaderPubKey, input, proofBytes);
        if (!computed) return false;
        return uint8ArrayEq(computed, output);
    }

    /** TPraos VRF input (see vrfInputs.ts). */
    private getVrfInput(slot: bigint, nonce: Uint8Array, seed: "leader" | "nonce"): Uint8Array {
        return tpraosVrfInput(slot, nonce, seed);
    }

    private biguintToU64BE(n: bigint): Uint8Array {
        const result = new Uint8Array(8);
        writeBigUInt64BE(result, n, 0);
        return result;
    }

    private getEraHeader(
        h: MultiEraHeader,
    ): AlonzoHeader | MaryHeader | AllegraHeader | ShelleyHeader | null {
        if (h.era > 5) return null;
        if (h.era === 5 && !isIAlonzoHeader(h.header)) {
            throw new Error("Invalid Alonzo header for era 5");
        }
        if (h.era === 4 && !isIMaryHeader(h.header)) {
            throw new Error("Invalid Mary header for era 4");
        }
        if (h.era === 3 && !isIAllegraHeader(h.header)) {
            throw new Error("Invalid Allegra header for era 3");
        }
        if (h.era === 2 && !isIShelleyHeader(h.header)) {
            throw new Error("Invalid Shelley header for era 2");
        }
        if (h.era === 1) return null;
        return h.header as
            | AlonzoHeader
            | MaryHeader
            | AllegraHeader
            | ShelleyHeader;
    }

    public async validate(
        h: MultiEraHeader,
        nonce: Uint8Array,
        config: any,
        options?: HeaderValidationOptions,
    ): Promise<boolean | null> {
        const genesis = await getCachedShelleyGenesis(config);
        if (!genesis) return false;

        const header = this.getEraHeader(h);
        if (
            header === null || header instanceof BabbageHeader ||
            header instanceof ConwayHeader
        ) {
            return null;
        }

        const activeSlotCoeff = genesis.activeSlotsCoeff;
        const maxKesEvo = BigInt(genesis.maxKESEvolutions);
        const slotsPerKESPeriod = BigInt(genesis.slotsPerKESPeriod);

        const issuer = new PoolKeyHash(header.body.issuerPubKey);
        const isKnownLeader = this.verifyKnownLeader(issuer, genesis);

        // Two VRFs per TPraos header, both proven under the pool's VRF key.
        const leaderCorrect = options?.skipVrf ? true : this.verifyVrfProof(
            this.getVrfInput(header.body.slot, nonce, "leader"),
            header.body.leaderVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.leaderVrfResult,
            "pre-babbage",
        );
        const nonceCorrect = options?.skipVrf ? true : this.verifyVrfProof(
            this.getVrfInput(header.body.slot, nonce, "nonce"),
            header.body.nonceVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.nonceVrfResult,
            "pre-babbage",
        );
        const correctProof = leaderCorrect && nonceCorrect;

        // Stake calculation using genesis as fallback
        let individualStake = 0n;
        const totalActiveStake = BigInt(Object.keys(genesis.genDelegs).length);

        if (isKnownLeader) {
            individualStake = 1n;
        }

        let stakeRatio: BigDecimal;
        if (totalActiveStake === 0n) {
            stakeRatio = BigDecimal.from(0);
        } else {
            stakeRatio = BigDecimal.from(individualStake).div(
                BigDecimal.from(totalActiveStake),
            );
        }

        const verifyLeaderStake = this.verifyLeaderEligibility(
            BigDecimal.from(activeSlotCoeff),
            stakeRatio,
            BigInt(`0x${toHex(header.body.leaderVrfResult.proofHash)}`),
        );

        const verifyOpCertValidity = this.verifyOpCertError(
            header.body.opCert,
            new PublicKey(header.body.issuerPubKey),
        );

        // ledger-ts cbor v2 CborObj is not a gerolamo cbor v1 instance — use body bytes directly
        const headerBodyBytes = header.body.toCborBytes();

        const verifyKES = this.verifyKESSignature(
            header.body.slot / slotsPerKESPeriod,
            header.body.opCert.kesPeriod,
            headerBodyBytes,
            header.body.opCert.kesPubKey,
            header.kesSignature,
            maxKesEvo,
        );

        const issuerHex = toHex(issuer.toCborBytes());
        const passed = correctProof && verifyLeaderStake &&
            verifyOpCertValidity && verifyKES;
        // Per-header result at debug: at info it was half of a 4 GB log (10 lines per header,
        // every verifier re-delivers every header). Failures are reported by the caller.
        if (!passed || headerTrace()) (passed ? logger.debug : logger.info).call(logger,
            `Header validation ${
                passed ? "PASSED" : "FAILED"
            } era=${h.era} slot=${header.body.slot}`,
            {
                issuerHex,
                isKnownLeader,
                correctProof,
                verifyLeaderStake,
                verifyOpCertValidity,
                verifyKES,
                passed,
            },
        );

        // Genesis delegates only produced every block while d = 1; as soon as
        // decentralisation kicked in, registered SPOs issue Shelley…Alonzo
        // headers too, so (like post-Babbage) a known-leader hit is logged,
        // not required.
        void verifyLeaderStake; // decided on the main thread (rules/leaderCheck.ts)
        return correctProof && verifyOpCertValidity && verifyKES;
    }
}

// For backward compatibility, provide a function that chooses the validator
export interface HeaderValidationOptions {
    /**
     * Skip the VRF proof checks (they need the epoch nonce). Used for headers of an epoch
     * whose nonce the applier has not derived yet: KES, op-cert and structure are checked
     * now, the VRF and the leader rule once the nonce is known (before the block is applied).
     */
    skipVrf?: boolean;
}

export async function validateHeader(
    h: MultiEraHeader,
    nonce: Uint8Array,
    config: any,
    options?: HeaderValidationOptions,
): Promise<boolean> {
    // Byron (0 = EBB, 1 = main) has no VRF/KES; structural checks only.
    if (isByronEra(h.era)) return validateByronHeader(h, config);
    const validator = h.era >= 6
        ? new ValidatePostBabbageHeader()
        : new ValidatePreBabbageHeader();
    const result = await validator.validate(h, nonce, config, options);
    return result ?? false;
}
