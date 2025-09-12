import {
    BabbageHeader,
    ConwayHeader,
    isIBabbageHeader,
    isIConwayHeader,
    KesPubKey,
    KesSignature,
    MultiEraHeader,
    PoolKeyHash,
    PublicKey,
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
import * as assert from "node:assert/strict";

import * as wasm from "wasm-kes";

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

export function verifyVrfProof(
    input: Uint8Array,
    output: Uint8Array,
    leaderPubKey: Uint8Array,
    cert: VrfCert,
): boolean {
    const proof = VrfProof03.fromBytes(cert.proof);
    const verify = proof.verify(leaderPubKey, input);
    const out = uint8ArrayEq(
        proof.toHash(),
        output,
    );
    return (
        verify &&
        out
    );
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
        cert.sequenceNumber - latestSeqNum <= 1 &&
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

export function getVrfInput(slot: bigint, nonce: Uint8Array): Uint8Array {
    return blake2b_256(
        concatUint8Array(biguintToU64BE(slot), nonce),
    );
}

function biguintToU64BE(n: bigint): Uint8Array {
    const result = new Uint8Array(8);
    writeBigUInt64BE(result, n, 0);
    return result;
}

function getEraHeader(h: MultiEraHeader): BabbageHeader | ConwayHeader {
    assert.default(h.era === 6 || h.era === 7);

    if (h.era === 6) {
        assert.default(isIBabbageHeader(h.header));
    } else {
        assert.default(isIConwayHeader(h.header));
    }
    return h.header;
}

export function validateHeader(
    h: MultiEraHeader,
    lState: RawNewEpochState,
    opCerts: PoolOperationalCert,
    activeSlotCoeff: number,
    nonce: Uint8Array,
): boolean {
    const header = getEraHeader(h);

    const issuer = new PoolKeyHash(header.body.issuerPubKey);
    const isKnownLeader = verifyKnownLeader(
        issuer,
        [[issuer, 0n]],
    );
    const correctProof = verifyVrfProof(
        getVrfInput(header.body.slot, nonce),
        header.body.vrfResult.proofHash,
        header.body.vrfPubKey,
        header.body.vrfResult,
    );
    const leaderVrfOut = concatUint8Array(
        Buffer.from("L"),
        header.body.leaderVrfOutput(),
    );

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
        opCerts.sequenceNumber,
    );

    const header_body_bytes = Cbor.encode(header.toCborObj().array[0])
        .toBuffer();
    const verifyKES = verifyKESSignature(
        header.body.slot / BigInt(lState.slotsPerKESPeriod),
        header.body.opCert.kesPeriod,
        header_body_bytes,
        header.body.opCert.kesPubKey,
        header.kesSignature,
        BigInt(lState.maxKESEvolutions),
    );

    console.log({
        isKnownLeader,
        correctProof,
        verifyLeaderStake,
        verifyOpCertValidity,
        verifyKES,
    });

    return (
        isKnownLeader &&
        correctProof &&
        verifyLeaderStake &&
        verifyOpCertValidity &&
        verifyKES
    );
}
