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
import { sql } from "bun";
import * as assert from "node:assert/strict";
import * as wasm from "wasm-kes";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";

const CERTIFIED_NATURAL_MAX = BigDecimal.fromString(
    "1157920892373161954235709850086879078532699846656405640394575840079131296399360000000000000000000000000000000000",
);

async function verifyKnownLeader(
    issuerPubKey: PoolKeyHash,
): Promise<boolean> {
    // Query database using JSON functions to check if pool exists with stake > 0
    const issuerHex = toHex(issuerPubKey.toCborBytes());
    const result = await sql`
        SELECT EXISTS(
            SELECT 1 FROM json_each(pools) 
            WHERE json_extract(value, '$.pool_id') = ${issuerHex} 
            AND CAST(json_extract(value, '$.active_stake') AS INTEGER) > 0
        ) as has_pool
        FROM pool_distr WHERE id = 1
    `.values() as [number][];

    return result.length > 0 && result[0][0] === 1;
}

async function verifyLeaderEligibility(
    issuerPubKey: PoolKeyHash,
    certified_leader_vrf: bigint,
): Promise<boolean> {
    // Query protocol parameters for active slot coefficient using JSON functions
    const protocolRows = await sql`
        SELECT COALESCE(
            json_extract(params, '$.activeSlotsCoeff'),
            json_extract(params, '$.active_slots_coeff'),
            0.05
        ) as activeSlotCoeff
        FROM protocol_params WHERE id = 1
    `.values() as [number][];

    if (protocolRows.length === 0) {
        return false;
    }
    const activeSlotCoeff = protocolRows[0][0];

    // Query pool distribution for stake ratio using JSON functions
    const issuerHex = toHex(issuerPubKey.toCborBytes());
    const stakeRows = await sql`
        SELECT
            CAST(json_extract(value, '$.active_stake') AS INTEGER) as individual_stake,
            total_active_stake
        FROM pool_distr, json_each(pools)
        WHERE id = 1 AND json_extract(value, '$.pool_id') = ${issuerHex}
    `.values() as [bigint, bigint][];

    let individualStake = 0n;
    let totalActiveStake = 0n;

    if (stakeRows.length > 0) {
        const [indStake, totalStake] = stakeRows[0];
        individualStake = indStake;
        totalActiveStake = totalStake;
    } else {
        // Pool not found, get total stake for ratio calculation
        const totalRows =
            await sql`SELECT total_active_stake FROM pool_distr WHERE id = 1`
                .values() as [bigint][];
        if (totalRows.length > 0) {
            totalActiveStake = totalRows[0][0];
        }
    }

    // Calculate stake ratio
    let stakeRatio: BigDecimal;
    if (totalActiveStake === 0n) {
        stakeRatio = BigDecimal.from(0);
    } else {
        stakeRatio = BigDecimal.from(individualStake).div(
            BigDecimal.from(totalActiveStake),
        );
    }

    const asc = BigDecimal.from(activeSlotCoeff);
    const denom = BigDecimal.sub(
        CERTIFIED_NATURAL_MAX,
        BigDecimal.fromBigint(certified_leader_vrf),
    );
    const recip_q = BigDecimal.div(CERTIFIED_NATURAL_MAX, denom);
    // const c = Math.log(1 - asc); // This is ln, i.e., log with base e~=2.718...
    const c = BigDecimal.sub(BigDecimal.fromBigint(1n), asc).ln();
    const x = BigDecimal.mul(stakeRatio, c).neg();

    /*
    Compare the Taylor-expansion of `x` to the threshold value `recip_q`
    Return the boolean value `x < recip_q` in the ordering
    */
    return expCmp(x, 1000n, 3n, recip_q).estimation === ExpOrd.LT;
}

function verifyOpCertError(
    cert: PoolOperationalCert,
    issuer: PublicKey,
): boolean {
    return verifyEd25519Signature_sync(
        cert.signature,
        concatUint8Array(
            cert.kesPubKey,
            fromHex(cert.sequenceNumber.toString(16).padStart(16, "0")),
            fromHex(cert.kesPeriod.toString(16).padStart(16, "0")),
        ),
        issuer.toBuffer(),
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
    return proof.verify(leaderPubKey, input) && uint8ArrayEq(
        (era === "pre-babbage") ? blake2b_256(proof.toBytes()) : proof.toHash(),
        output,
    );
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
    assert.ok(
        h.era === 2 || h.era === 3 || h.era === 4 || h.era === 5 ||
            h.era === 6 || h.era === 7,
    );

    if (h.era === 2) {
        assert.ok(isIShelleyHeader(h.header));
    }
    if (h.era === 3) {
        assert.ok(isIAllegraHeader(h.header));
    }
    if (h.era === 4) {
        assert.ok(isIMaryHeader(h.header));
    }
    if (h.era === 5) {
        assert.ok(isIAlonzoHeader(h.header));
    }
    if (h.era === 6) {
        assert.ok(isIBabbageHeader(h.header));
    }
    if (h.era === 7) {
        assert.ok(isIConwayHeader(h.header));
    }
    return h.header;
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

export async function validateHeader(
    h: MultiEraHeader,
    nonce: Uint8Array,
): Promise<boolean> {
    // Query protocol parameters from database
    const protocolRows = await sql`
        SELECT
            COALESCE(json_extract(params, '$.maxKESEvolutions'), json_extract(params, '$.max_kes_evolutions'), 62) as maxKESEvolutions,
            COALESCE(json_extract(params, '$.slotsPerKESPeriod'), json_extract(params, '$.slots_per_kes_period'), 129600) as slotsPerKESPeriod
        FROM protocol_params WHERE id = 1
    `.values() as [number, number][];

    if (protocolRows.length === 0) {
        return false;
    }

    const [maxKESEvolutions, slotsPerKESPeriod] = protocolRows[0];

    const header = getEraHeader(h);
    const maxKesEvo = BigInt(maxKESEvolutions);
    const slotsPerKESPeriodBig = BigInt(slotsPerKESPeriod);

    const issuer = new PoolKeyHash(header.body.issuerPubKey);
    const isKnownLeader = await verifyKnownLeader(issuer);
    const leaderVrfOut = concatUint8Array(
        Buffer.from("L"),
        header.body.leaderVrfOutput(),
    );

    let correctProof: boolean = false;

    if (isIAlonzoHeader(header)) {
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

    const verifyLeaderStake = await verifyLeaderEligibility(
        issuer,
        BigInt(`0x${toHex(leaderVrfOut)}`),
    );

    const verifyOpCertValidity = verifyOpCertError(
        header.body.opCert,
        new PublicKey(header.body.issuerPubKey),
    );

    const header_body_bytes = Cbor.encode(header.toCborObj().array[0])
        .toBuffer();

    const verifyKES = verifyKESSignature(
        header.body.slot / slotsPerKESPeriodBig,
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
