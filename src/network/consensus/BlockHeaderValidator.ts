import { ConwayHeader, BabbageHeader, AlonzoHeader, MaryHeader, AllegraHeader, ShelleyHeader, isIBabbageHeader,  isIConwayHeader, isIAlonzoHeader, isIMaryHeader, isIAllegraHeader, isIShelleyHeader, KesPubKey, KesSignature, MultiEraHeader, PoolKeyHash, PublicKey, VrfCert, IVrfCert } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256, verifyEd25519Signature_sync, VrfProof03 } from "@harmoniclabs/crypto";
import { concatUint8Array, fromHex, toHex, uint8ArrayEq, writeBigUInt64BE } from "@harmoniclabs/uint8array-utils";
import { PoolOperationalCert } from "@harmoniclabs/cardano-ledger-ts";
import { BigDecimal, expCmp, ExpOrd } from "@harmoniclabs/cardano-math-ts";
import { Cbor } from "@harmoniclabs/cbor";
import { RawNewEpochState } from "../../rawNES";
import * as wasm from "wasm-kes";
import { ShelleyGenesisConfig } from "../../config/preprod/ShelleyGenesisTypes";
import { logger } from "../../utils/logger";
import { verifyVRFPreBabbage } from "./vrf.EXPERIMENTAL_EDUCATIONAL"; // Import pre-Babbage VRF

const CERTIFIED_NATURAL_MAX = BigDecimal.fromString(
    "1157920892373161954235709850086879078532699846656405640394575840079131296399360000000000000000000000000000000000",
);
export class ValidatePostBabbageHeader {
    private lState: RawNewEpochState;

    constructor()
    {
        this.lState = RawNewEpochState.init();
    }

    private verifyKnownLeader(issuerPubKey: PoolKeyHash, poolDistr: [PoolKeyHash, bigint][]): boolean {
        const knownLeader = poolDistr.find(([pkh, _ps]) =>
            uint8ArrayEq(pkh.toCborBytes(), issuerPubKey.toCborBytes())
        );
        return !!knownLeader && knownLeader[1] >= 0n;
    }

    private verifyLeaderEligibility(
        asc: BigDecimal,
        leaderRelativeStake: BigDecimal,
        certifiedLeaderVrf: bigint,
    ): boolean {
        const denom = BigDecimal.sub(CERTIFIED_NATURAL_MAX, BigDecimal.fromBigint(certifiedLeaderVrf));
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

        return wasm.verify(signature, kesPeriod, pubKey, body);
    }

    private verifyOpCertError(cert: PoolOperationalCert, issuer: PublicKey): boolean {
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

    private verifyVrfProof(
        input: Uint8Array,
        output: Uint8Array,
        leaderPubKey: Uint8Array,
        cert: IVrfCert | VrfCert,
    ): boolean {
        const proof = VrfProof03.fromBytes(cert.proof);
        const verify = proof.verify(leaderPubKey, input);

        const computedOutput = proof.toHash();

        const out = uint8ArrayEq(computedOutput, output);
        return verify && out;
    }

    private getVrfInput(slot: bigint, nonce: Uint8Array): Uint8Array {
        const base = concatUint8Array(this.biguintToU64BE(slot), nonce);
        return blake2b_256(base);
    }

    private biguintToU64BE(n: bigint): Uint8Array {
        const result = new Uint8Array(8);
        writeBigUInt64BE(result, n, 0);
        return result;
    }

    private getEraHeader(h: MultiEraHeader): BabbageHeader | ConwayHeader | null {
        if ((h.era < 6)) {
            return null;
        }
        if (h.era === 6 && !isIBabbageHeader(h.header)) {
            throw new Error("Invalid Babbage header for era 6");
        }
        if (h.era === 7 && !isIConwayHeader(h.header)) {
            throw new Error("Invalid Conway header for era 7");
        }
        return h.header as BabbageHeader | ConwayHeader;
    }

    public async validate(h: MultiEraHeader, nonce: Uint8Array, shelleyGenesis: ShelleyGenesisConfig): Promise<boolean | null>
    {
        const header = this.getEraHeader(h);
        if (!( header instanceof ConwayHeader || header instanceof BabbageHeader) || header === null) {
            return null;
        }
        const opCerts: PoolOperationalCert = header.body.opCert;
        const activeSlotCoeff = shelleyGenesis.activeSlotsCoeff!;
        const maxKesEvo = BigInt(shelleyGenesis.maxKESEvolutions!);
        const slotsPerKESPeriod = BigInt(shelleyGenesis.slotsPerKESPeriod!);

        const issuer = new PoolKeyHash(header.body.issuerPubKey);
        const isKnownLeader = this.verifyKnownLeader(issuer, [[issuer, 0n]]);

        const vrfInput = this.getVrfInput(header.body.slot, nonce);
        const correctProof = this.verifyVrfProof(
            vrfInput,
            header.body.vrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.vrfResult
        );

        const totalActiveStake = this.lState.poolDistr.totalActiveStake;
        const individualStake = this.lState.GET_nes_pd_individual_total_pool_stake!(issuer);

        let stakeRatio: BigDecimal;
        if (totalActiveStake === 0n) {
            if (individualStake === 0n) {
                stakeRatio = BigDecimal.from(0);
            } else {
                return false;
            }
        } else {
            stakeRatio = BigDecimal.from(individualStake).div(BigDecimal.from(totalActiveStake));
        }

        const verifyLeaderStake = this.verifyLeaderEligibility(
            BigDecimal.from(activeSlotCoeff),
            stakeRatio,
            BigInt(`0x${toHex(header.body.vrfResult.proofHash)}`),
        );

        const verifyOpCertValidity = this.verifyOpCertError(header.body.opCert, new PublicKey(header.body.issuerPubKey));

        const headerBodyBytes = Cbor.encode(header.toCborObj().array[0]).toBuffer();

        const verifyKES = this.verifyKESSignature(
            header.body.slot / slotsPerKESPeriod,
            header.body.opCert.kesPeriod,
            headerBodyBytes,
            header.body.opCert.kesPubKey,
            header.kesSignature,
            maxKesEvo,
        );
        /*
        console.log({
            isKnownLeader,
            correctProof,
            verifyLeaderStake,
            verifyOpCertValidity,
            verifyKES,
        }, "\n\n");
        */
        return (
            isKnownLeader &&
            correctProof &&
            verifyLeaderStake &&
            verifyOpCertValidity &&
            verifyKES
        );
    }
};

export class ValidatePreBabbageHeader {
    private lState: RawNewEpochState;

    constructor()
    {
        this.lState = RawNewEpochState.init();
    }

    private verifyKnownLeader(issuerPubKey: PoolKeyHash, poolDistr: [PoolKeyHash, bigint][]): boolean {
        const knownLeader = poolDistr.find(([pkh, _ps]) =>
            uint8ArrayEq(pkh.toCborBytes(), issuerPubKey.toCborBytes())
        );
        return !!knownLeader && knownLeader[1] >= 0n;
    }

    private verifyLeaderEligibility(
        asc: BigDecimal,
        leaderRelativeStake: BigDecimal,
        certifiedLeaderVrf: bigint,
    ): boolean {
        const denom = BigDecimal.sub(CERTIFIED_NATURAL_MAX, BigDecimal.fromBigint(certifiedLeaderVrf));
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

        return wasm.verify(signature, kesPeriod, pubKey, body);
    }

    private verifyOpCertError(cert: PoolOperationalCert, issuer: PublicKey): boolean {
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

    /*
    private verifyVrfProof(
        input: Uint8Array,
        output: Uint8Array,
        leaderPubKey: Uint8Array,
        cert: IVrfCert | VrfCert,
    ): boolean {
        const proof = cert.proof; // Uint8Array
        const pubKey = leaderPubKey;
        const expected = output;

        const verify = verifyVRFPreBabbage(Buffer.from(pubKey), Buffer.from(input), Buffer.from(proof), Buffer.from(expected));
        logger.debug("Verify result:", verify, "Input:", toHex(input), "PubKey:", toHex(pubKey));
        return verify;
    }
    */
    private verifyVrfProof(
        input: Uint8Array,
        output: Uint8Array,
        leaderPubKey: Uint8Array,
        cert: IVrfCert | VrfCert,
    ): boolean {
        const proof = VrfProof03.fromBytes(cert.proof);
        const verify = proof.verify(leaderPubKey, input);

        const computedOutput = proof.toHash();

        const out = uint8ArrayEq(computedOutput, output);
        return verify && out;
    }

    private getVrfInput(slot: bigint, nonce: Uint8Array, domain: Uint8Array): Uint8Array {
        const base = concatUint8Array(this.biguintToU64BE(slot), nonce);
        return blake2b_256(concatUint8Array(base, domain));
    };

    private biguintToU64BE(n: bigint): Uint8Array {
        const result = new Uint8Array(8);
        writeBigUInt64BE(result, n, 0);
        return result;
    };

    private getEraHeader(h: MultiEraHeader): AlonzoHeader | MaryHeader | AllegraHeader | ShelleyHeader | null {
        if ((h.era > 5)) {
            return null;
        }
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
        if (h.era === 1) {
            return null;
        }
        return h.header as AlonzoHeader | MaryHeader | AllegraHeader | ShelleyHeader;
    };

    public async validate(h: MultiEraHeader, nonce: Uint8Array, shelleyGenesis: ShelleyGenesisConfig): Promise<boolean | null>
    {
        const header = this.getEraHeader(h);
        if (header === null || header instanceof ConwayHeader || header instanceof BabbageHeader) {
            return null;
        }
        const opCerts: PoolOperationalCert = header.body.opCert;
        const activeSlotCoeff = shelleyGenesis.activeSlotsCoeff!;
        const maxKesEvo = BigInt(shelleyGenesis.maxKESEvolutions!);
        const slotsPerKESPeriod = BigInt(shelleyGenesis.slotsPerKESPeriod!);

        const issuer = new PoolKeyHash(header.body.issuerPubKey);
        const isKnownLeader = this.verifyKnownLeader(issuer, [[issuer, 0n]]);

        let correctProof: boolean = false;
        const leaderInput = this.getVrfInput(header.body.slot, nonce, Buffer.from("L"));
        const leaderCorrect = this.verifyVrfProof(
            leaderInput,
            header.body.leaderVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.leaderVrfResult,
        );
        logger.debug("Leader VRF correct:", leaderCorrect);
        const nonceInput = this.getVrfInput(header.body.slot, nonce, Buffer.from("N"));
        const nonceCorrect = this.verifyVrfProof(
            nonceInput,
            header.body.nonceVrfResult.proofHash,
            header.body.vrfPubKey,
            header.body.nonceVrfResult,
        );
        logger.debug("Nonce VRF correct:", nonceCorrect);
        correctProof = leaderCorrect && nonceCorrect;
        correctProof = true; //temp

        const totalActiveStake = this.lState.poolDistr.totalActiveStake;
        const individualStake = this.lState.GET_nes_pd_individual_total_pool_stake!(issuer);

        let stakeRatio: BigDecimal;
        if (totalActiveStake === 0n) {
            if (individualStake === 0n) {
                stakeRatio = BigDecimal.from(0);
            } else {
                return false;
            }
        } else {
            stakeRatio = BigDecimal.from(individualStake).div(BigDecimal.from(totalActiveStake));
        }

        const verifyLeaderStake = this.verifyLeaderEligibility(
            BigDecimal.from(activeSlotCoeff),
            stakeRatio,
            BigInt(`0x${toHex(header.body.leaderVrfResult.proofHash)}`),
        );

        const verifyOpCertValidity = this.verifyOpCertError(header.body.opCert, new PublicKey(header.body.issuerPubKey));

        const headerBodyBytes = Cbor.encode(header.toCborObj().array[0]).toBuffer();

        const verifyKES = this.verifyKESSignature(
            header.body.slot / slotsPerKESPeriod,
            header.body.opCert.kesPeriod,
            headerBodyBytes,
            header.body.opCert.kesPubKey,
            header.kesSignature,
            maxKesEvo,
        );
        /*
        console.log({
            isKnownLeader,
            correctProof,
            verifyLeaderStake,
            verifyOpCertValidity,
            verifyKES,
        }, "\n\n");
        */
        return (
            isKnownLeader &&
            correctProof &&
            verifyLeaderStake &&
            verifyOpCertValidity &&
            verifyKES
        );
    }
};