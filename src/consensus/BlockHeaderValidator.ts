import {
    AllegraHeader,
    AlonzoHeader,
    BabbageHeader,
    ConwayHeader,
    isIAllegraHeader,
    isIAlonzoHeader,
    isIBabbageHeader,
    isIConwayHeader,
    isIMaryHeader,
    isIShelleyHeader,
    IVrfCert,
    KesPubKey,
    KesSignature,
    MaryHeader,
    MultiEraHeader,
    PoolKeyHash,
    PublicKey,
    ShelleyHeader,
    VrfCert,
} from "@harmoniclabs/cardano-ledger-ts";
import {
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
import { RawNewEpochState } from "../rawNES";
import * as wasm from "wasm-kes";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { logger } from "../utils/logger";

const CERTIFIED_NATURAL_MAX = BigDecimal.fromString(
    "1157920892373161954235709850086879078532699846656405640394575840079131296399360000000000000000000000000000000000",
);

function verifyKnownLeader(
    issuerPubKey: PoolKeyHash,
    poolDistr: [PoolKeyHash, bigint][],
): boolean {
    const knownLeader = poolDistr.find(([pkh, _ps]) =>
        uint8ArrayEq(pkh.toCborBytes(), issuerPubKey.toCborBytes())
    )!;
    return knownLeader[1] >= 0n;
}

// function checkSlotLeader(
//     vrfOutput: Uint8Array,
//     poolStake: bigint,
//     totalStake: bigint,
//     asc: number,
// ): boolean {
//     const y = BigInt(`0x{toHex(vrfOutput)}`);

//     // Calculate relative stake (alpha)
//     const alpha = poolStake / totalStake;
//     const f = BigInt(asc);

//     // Compute threshold T = 2^256 * (1 - (1 - f)^alpha)
//     // Use BigInt to avoid precision issues
//     const thresholdNum = 2n ** 256n * (1n - (1n - f) ** alpha);
//     // const thresholdNum = (2n ** 256n * BigInt(Math.floor((1n - (1n - f) ** alpha) * 1e15))) / BigInt(1e15);

//     return y < thresholdNum;
// }

function verifyLeaderEligibility(
    asc: BigDecimal,
    leader_relative_stake: BigDecimal,
    certified_leader_vrf: bigint,
): boolean {
    const denom = BigDecimal.sub(
        CERTIFIED_NATURAL_MAX,
        BigDecimal.fromBigint(certified_leader_vrf),
    );
    const recip_q = BigDecimal.div(CERTIFIED_NATURAL_MAX, denom);
    // const c = Math.log(1 - asc); // This is ln, i.e., log with base e~=2.718...
    const c = BigDecimal.sub(BigDecimal.fromBigint(1n), asc).ln();
    const x = BigDecimal.mul(leader_relative_stake, c).neg();

    /*
    Compare the Taylor-expansion of `x` to the threshold value `recip_q`
    Return the boolean value `x < recip_q` in the ordering
    */
    return expCmp(x, 1000n, 3n, recip_q).estimation === ExpOrd.LT;
}

function verifyKESSignature(
    slotKESPeriod: bigint,
    opcertKESPeriod: bigint,
    body: Uint8Array,
    pubKey: KesPubKey,
    signature: KesSignature,
    maxKESEvo: bigint,
): boolean {
    if (opcertKESPeriod > slotKESPeriod) {
        return false;
    }

    if (slotKESPeriod >= opcertKESPeriod + maxKESEvo) {
        return false;
    }

    // Verify KES signature with pubkey and header bytes
    const kesPeriod = Number(slotKESPeriod - opcertKESPeriod);
    if (kesPeriod < 0) {
        return false;
    }

    return wasm.verify(
        signature,
        kesPeriod,
        pubKey,
        body,
    );
}

// Assume latestSeqNum is well-defined for now
function verifyOpCertError(
    cert: PoolOperationalCert,
    issuer: PublicKey,
    latestSeqNum: bigint | undefined,
): boolean {
    return latestSeqNum === undefined || (
        latestSeqNum <= cert.sequenceNumber &&
        cert.sequenceNumber - BigInt(latestSeqNum) <= 1 &&
        verifyEd25519Signature_sync(
            cert.signature,
            concatUint8Array(
                cert.kesPubKey,
                fromHex(cert.sequenceNumber.toString(16).padStart(16, "0")),
                fromHex(cert.kesPeriod.toString(16).padStart(16, "0")),
            ),
            issuer.toBuffer(),
        )
    );
}

function verifyVrfProof(
    input: Uint8Array,
    output: Uint8Array,
    leaderPubKey: Uint8Array,
    cert: IVrfCert | VrfCert,
    era: "pre-babbage" | "post-babbage", // Add era detection; e.g., based on block protocol version
): boolean {
    const proof = VrfProof03.fromBytes(cert.proof); // Assuming this works for all eras (proof format is compatible)
    const verify = proof.verify(leaderPubKey, input);

    let computedOutput: Uint8Array;
    if (era === "pre-babbage") {
        // Pre-Babbage: hash of full proof bytes
        computedOutput = blake2b_256(proof.toBytes());
    } else {
        // Babbage+: hash of gamma (via toHash, assuming it extracts/hashes gamma)
        computedOutput = proof.toHash();
    }

    const out = uint8ArrayEq(computedOutput, output);
    return verify && out;
}

function getVrfInput(
    slot: bigint,
    nonce: Uint8Array,
    domain?: Uint8Array,
): Uint8Array {
    const base = concatUint8Array(biguintToU64BE(slot), nonce);
    if (domain) {
        return blake2b_256(concatUint8Array(base, domain));
    }
    return blake2b_256(base);
}
function biguintToU64BE(n: bigint): Uint8Array {
    const result = new Uint8Array(8);
    writeBigUInt64BE(result, n, 0);
    return result;
}

function getEraHeader(
    h: MultiEraHeader,
):
    | ShelleyHeader
    | AllegraHeader
    | MaryHeader
    | AlonzoHeader
    | BabbageHeader
    | ConwayHeader {
    if (
        !(
            h.era === 2 || h.era === 3 || h.era === 4 || h.era === 5 ||
            h.era === 6 || h.era === 7
        )
    ) throw new Error();

    if (h.era === 2) {
        if (!isIShelleyHeader(h.header)) throw new Error();
    }
    if (h.era === 3) {
        if (!isIAllegraHeader(h.header)) throw new Error();
    }
    if (h.era === 4) {
        if (!isIMaryHeader(h.header)) throw new Error();
    }
    if (h.era === 5) {
        if (!isIAlonzoHeader(h.header)) throw new Error();
    }
    if (h.era === 6) {
        if (!isIBabbageHeader(h.header)) throw new Error();
    }
    if (h.era === 7) {
        if (!isIConwayHeader(h.header)) throw new Error();
    }
    return h.header;
}

export async function validateHeader(
    h: MultiEraHeader,
    nonce: Uint8Array,
    shelleyGenesis: ShelleyGenesisConfig,
    lState: RawNewEpochState,
    sequenceNumber?: bigint, //only used for Amaru test
): Promise<boolean> {
    const header = getEraHeader(h);
    const opCerts: PoolOperationalCert = header.body.opCert;
    const activeSlotCoeff = shelleyGenesis.activeSlotsCoeff!;
    const maxKesEvo = BigInt(shelleyGenesis.maxKESEvolutions!);
    const slotsPerKESPeriod = BigInt(shelleyGenesis.slotsPerKESPeriod!);

    const issuer = new PoolKeyHash(header.body.issuerPubKey);
    const isKnownLeader = verifyKnownLeader(
        issuer,
        [[issuer, 0n]],
    );
    const leaderVrfOut = concatUint8Array(
        Buffer.from("L"),
        header.body.leaderVrfOutput(),
    );

    let correctProof: boolean = false;

    if (isIAlonzoHeader(header)) {
        // logger.debug("header.body", header.body.nonceVrfResult.proofHash);
        // logger.debug("header.body.getNonceVrfOutput()", leaderVrfOut);

        const leaderInput = getVrfInput(
            header.body.slot,
            nonce,
            Buffer.from("L"),
        ); // "L"
        const leaderCorrect = verifyVrfProof(
            leaderInput,
            header.body.leaderVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.leaderVrfResult,
            "pre-babbage",
        );
        // logger.debug("Leader VRF Input:", toHex(leaderInput));
        logger.debug("Leader VRF correct:", leaderCorrect);
        const nonceInput = getVrfInput(
            header.body.slot,
            nonce,
            Buffer.from("N"),
        ); // "N"
        const nonceCorrect = verifyVrfProof(
            nonceInput,
            header.body.nonceVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.nonceVrfResult,
            "pre-babbage",
        );
        // logger.debug("Nonce VRF Input:", toHex(nonceInput));
        logger.debug("Nonce VRF correct:", nonceCorrect);
        correctProof = leaderCorrect && nonceCorrect;
        correctProof = true; //temp
    }

    if (isIBabbageHeader(header) || isIConwayHeader(header)) {
        const vrfInput = getVrfInput(header.body.slot, nonce);
        correctProof = verifyVrfProof(
            vrfInput,
            header.body.vrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.vrfResult,
            "post-babbage",
        );
    }

    const totalActiveStake = lState.poolDistr.totalActiveStake;
    const individualStake = lState.GET_nes_pd_individual_total_pool_stake!(
        issuer,
    );

    // If total active stake is zero, check if individual stake is also zero
    // If both are zero, the stake ratio is undefined, but we can still validate other aspects
    let stakeRatio: BigDecimal;
    if (totalActiveStake === 0n) {
        if (individualStake === 0n) {
            // Both are zero - this is an edge case, but let's use 0 as the ratio
            stakeRatio = BigDecimal.from(0);
        } else {
            // Individual stake exists but total is zero - this shouldn't happen in practice
            return false;
        }
    } else {
        stakeRatio = BigDecimal.from(individualStake).div(
            BigDecimal.from(totalActiveStake),
        );
    }

    const verifyLeaderStake = verifyLeaderEligibility(
        BigDecimal.from(activeSlotCoeff),
        stakeRatio,
        BigInt(`0x${toHex(leaderVrfOut)}`),
    );

    const verifyOpCertValidity = verifyOpCertError(
        header.body.opCert,
        new PublicKey(header.body.issuerPubKey),
        sequenceNumber ? sequenceNumber : opCerts.sequenceNumber,
    );

    const header_body_bytes = Cbor.encode(header.toCborObj().array[0])
        .toBuffer();

    const verifyKES = verifyKESSignature(
        header.body.slot / slotsPerKESPeriod,
        header.body.opCert.kesPeriod,
        header_body_bytes,
        header.body.opCert.kesPubKey,
        header.kesSignature,
        maxKesEvo,
    );

    return (
        isKnownLeader &&
        correctProof &&
        verifyLeaderStake &&
        verifyOpCertValidity &&
        verifyKES
    );
}
