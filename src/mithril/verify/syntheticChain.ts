/**
 * Test support: a tiny but valid Mithril certificate chain signed with throwaway keys.
 *
 * genesis certificate (Ed25519, test genesis key) -> one standard certificate signed by a single
 * STM signer (real BLS signature, real lottery with phi_f < 1, one-leaf AVK Merkle tree). The
 * standard certificate can sign any protocol message, e.g. a cardano-database Merkle root, so
 * tests can exercise the client and the artifact server end to end without the network.
 * Never use these keys for anything else.
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

import { computeCertificateHash, parseCertificate, protocolMessageHash, protocolParametersHash, type Certificate } from "./certificate";
import { encodeJsonHex, stringifyJsonLossless } from "./json";
import { aggregateVerificationKeyJson, concatenationProofJson, evaluateDenseMapping, registrationLeafBytes, type AggregateVerificationKey } from "./stm";
import { isLotteryWon } from "./lottery";

export type SyntheticChain = {
    genesisVkeyHex: string; // JSON hex, as the published genesis.vkey files
    genesis: Certificate;
    standard: Certificate;
    /** Raw JSON text of each certificate, keyed by hash. */
    texts: Map<string, string>;
};

const SEED = (b: number) => new Uint8Array(32).fill(b);

export function buildSyntheticChain(opts: {
    network?: string;
    epoch?: number;
    signedEntityType: Record<string, unknown>;
    messageParts: Record<string, string>;
}): SyntheticChain {
    const network = opts.network ?? "testnet";
    const epoch = opts.epoch ?? 10;
    const params = { k: 5n, m: 100n, phiF: 0.65 };
    const paramsJson = { k: 5, m: 100, phi_f: 0.65 };

    // Signer: sk, vk = sk * G2, stake.
    const sk = (BigInt("0x" + Buffer.from(blake2b(SEED(7), { dkLen: 32 })).toString("hex")) % (bls.params.r - 1n)) + 1n;
    const vk = bls.G2.ProjectivePoint.BASE.multiply(sk).toRawBytes(true);
    const stake = 1_000_000_000n;
    const avk: AggregateVerificationKey = { root: blake2b(registrationLeafBytes(vk, stake), { dkLen: 32 }), nrLeaves: 1, totalStake: stake };
    const avkHex = encodeJsonHex(aggregateVerificationKeyJson(avk));

    // Genesis key.
    const gsk = SEED(9);
    const gvk = ed25519.getPublicKey(gsk);
    const genesisVkeyHex = encodeJsonHex(`[${Array.from(gvk).join(",")}]`);

    const time = "2026-01-01T00:00:00.000000001Z";
    const nextParts = { next_aggregate_verification_key: avkHex, next_protocol_parameters: protocolParametersHash(params), current_epoch: String(epoch) };

    // Genesis certificate.
    const gPm = { ...nextParts };
    const gSigned = protocolMessageHash(new Map(Object.entries(gPm)) as never);
    const genesisJson: Record<string, unknown> = {
        hash: "",
        previous_hash: "",
        epoch,
        signed_entity_type: { MithrilStakeDistribution: epoch },
        metadata: { network, version: "0.1.0", parameters: paramsJson, initiated_at: time, sealed_at: time, signers: [] },
        protocol_message: { message_parts: gPm },
        signed_message: gSigned,
        aggregate_verification_key: avkHex,
        multi_signature: "",
        genesis_signature: Buffer.from(ed25519.sign(new TextEncoder().encode(gSigned), gsk)).toString("hex"),
    };
    genesisJson.hash = computeCertificateHash(parseCertificate(genesisJson));
    const genesis = parseCertificate(genesisJson);

    // Standard certificate, same epoch: same AVK and parameters as the genesis certificate.
    const sPm = { ...nextParts, ...opts.messageParts };
    const sSigned = protocolMessageHash(new Map(Object.entries(sPm)) as never);
    const msgp = new Uint8Array([...new TextEncoder().encode(sSigned), ...avk.root]);
    const hm = bls.G1.hashToCurve(msgp, { DST: new Uint8Array(0) } as never) as unknown as ReturnType<typeof bls.G1.ProjectivePoint.fromHex>;
    const sigma = hm.multiply(sk).toRawBytes(true);
    const indexes: bigint[] = [];
    for (let i = 0n; i <= params.m && indexes.length < Number(params.k); i++) {
        if (isLotteryWon(params.phiF, evaluateDenseMapping(sigma, msgp, i), stake, stake)) indexes.push(i);
    }
    const proofJson = concatenationProofJson({ signatures: [{ sigma, indexes, signerIndex: 0n, vk, stake }], batchProof: { values: [], indices: [0] } });
    const standardJson: Record<string, unknown> = {
        hash: "",
        previous_hash: genesis.hash,
        epoch,
        signed_entity_type: opts.signedEntityType,
        metadata: { network, version: "0.1.0", parameters: paramsJson, initiated_at: time, sealed_at: time, signers: [{ party_id: "pool1synthetic", stake }] },
        protocol_message: { message_parts: sPm },
        signed_message: sSigned,
        aggregate_verification_key: avkHex,
        multi_signature: encodeJsonHex(proofJson),
        genesis_signature: "",
    };
    standardJson.hash = computeCertificateHash(parseCertificate(standardJson));
    const standard = parseCertificate(standardJson);

    const texts = new Map([
        [genesis.hash, stringifyJsonLossless(genesisJson)],
        [standard.hash, stringifyJsonLossless(standardJson)],
    ]);
    return { genesisVkeyHex, genesis, standard, texts };
}
