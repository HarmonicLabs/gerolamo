import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeCertificateHash, parseCertificate, phiFFixed, protocolMessageHash, rfc3339Nanos, type Certificate } from "./certificate";
import { parseJsonLossless } from "./json";
import {
    decodeGenesisVerificationKey,
    verifyCertificateChain,
    verifyGenesisCertificate,
    verifyStandardCertificate,
    verifyStandardCertificateIntegrity,
} from "./verifier";

const FIX = join(import.meta.dir, "..", "__fixtures__", "certs");
const text = (rel: string) => Bun.file(join(FIX, rel)).text();
const cert = async (rel: string) => parseCertificate(await text(rel));
/** A certificate re-parsed after editing its JSON (so every test starts from a fresh copy). */
const edited = async (rel: string, edit: (c: Record<string, any>) => void): Promise<Certificate> => {
    const c = parseJsonLossless(await text(rel)) as Record<string, any>;
    edit(c);
    return parseCertificate(c);
};
const flipHex = (s: string, at: number): string => s.slice(0, at) + ((parseInt(s[at]!, 16) ^ 1).toString(16)) + s.slice(at + 1);

describe("certificate hashing", () => {
    test("content hash, protocol message hash: every fixture", async () => {
        for (const rel of ["preview/genesis.json", "preview/hop1.json", "preview/hop2.json", "preview/cdb.json", "preview/cdb-previous.json", "mainnet/multi.json", "mainnet/multi-previous.json"]) {
            const c = await cert(rel);
            expect(computeCertificateHash(c)).toBe(c.hash);
            expect(protocolMessageHash(c.protocolMessage)).toBe(c.signedMessage);
        }
    });

    test("U8F24 rounding and RFC 3339 nanoseconds", () => {
        expect(phiFFixed(0.7)).toBe(Math.round(0.7 * 2 ** 24));
        expect(phiFFixed(0.5 / 2 ** 24)).toBe(0); // tie rounds to even
        expect(phiFFixed(1.5 / 2 ** 24)).toBe(2);
        expect(rfc3339Nanos("1970-01-01T00:00:01.000000001Z")).toBe(1_000_000_001n);
        expect(rfc3339Nanos("1970-01-01T01:00:00+01:00")).toBe(0n);
    });

    test("unknown protocol message parts and SNARK fields are rejected", async () => {
        await expect(edited("preview/cdb.json", (c) => { c.protocol_message.message_parts.extra = "x"; })).rejects.toThrow(/unknown part/);
        await expect(edited("preview/cdb.json", (c) => { c.protocol_message.hash_scheme = "rigid"; })).rejects.toThrow(/hash_scheme/);
        await expect(edited("preview/cdb.json", (c) => { c.ancillary_verifier_data = "00"; })).rejects.toThrow(/SNARK/);
    });
});

describe("certificate verification (port of MithrilCertificateVerifier)", () => {
    test("standard certificates verify against their predecessors (same epoch and new epoch)", async () => {
        verifyStandardCertificate(await cert("preview/cdb.json"), await cert("preview/cdb-previous.json"));
        verifyStandardCertificate(await cert("mainnet/multi.json"), await cert("mainnet/multi-previous.json"));
        verifyStandardCertificate(await cert("preview/hop2.json"), await cert("preview/hop1.json")); // epoch 1131 -> 1130
        verifyStandardCertificate(await cert("preview/hop1.json"), await cert("preview/genesis.json")); // epoch 1130 -> genesis 1129
    });

    test("genesis certificate verifies under the preview genesis key only", async () => {
        const g = await cert("preview/genesis.json");
        verifyGenesisCertificate(g, decodeGenesisVerificationKey(await text("preview/genesis.vkey")));
        expect(() => verifyGenesisCertificate(g, decodeGenesisVerificationKey(textSync("mainnet/genesis.vkey")))).toThrow(/CertificateGenesis/);
    });

    test("full walk hop2 -> hop1 -> genesis", async () => {
        const store = new Map<string, Certificate>();
        for (const rel of ["preview/genesis.json", "preview/hop1.json"]) {
            const c = await cert(rel);
            store.set(c.hash, c);
        }
        const r = await verifyCertificateChain(await cert("preview/hop2.json"), {
            genesisVkey: decodeGenesisVerificationKey(await text("preview/genesis.vkey")),
            retrieve: async (h) => {
                const c = store.get(h);
                if (!c) throw new Error(`missing ${h}`);
                return c;
            },
        });
        expect(r.hops.map((h) => h.kind)).toEqual(["standard", "standard", "genesis"]);
        expect(r.genesisHash).toBe((await cert("preview/genesis.json")).hash);
    });

    test("the walk stops at a certificate verified before", async () => {
        const hop1 = await cert("preview/hop1.json");
        const r = await verifyCertificateChain(await cert("preview/hop2.json"), {
            genesisVkey: new Uint8Array(32),
            retrieve: async () => hop1,
            verifiedCache: new Set([hop1.hash]),
        });
        expect(r.stoppedAtCache).toBe(true);
        expect(r.hops.length).toBe(1);
    });

    describe("negative", () => {
        test("flipped bit in a multi-signature byte", async () => {
            const raw = parseJsonLossless(await text("mainnet/multi.json")) as Record<string, any>;
            // Flip one hex digit inside the first sigma ("sigma":[...] starts right after the prefix).
            const at = raw.multi_signature.indexOf(Buffer.from('"sigma":[', "utf8").toString("hex")) + 40;
            raw.multi_signature = flipHex(raw.multi_signature, at);
            expect(() => verifyStandardCertificateIntegrity(parseCertificate(raw))).toThrow();
        });
        test("flipped bit in signed_message", async () => {
            const c = await edited("preview/cdb.json", (c) => { c.signed_message = flipHex(c.signed_message, 10); });
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/CertificateHashUnmatch/);
        });
        test("altered signer stake in the metadata", async () => {
            const c = await edited("mainnet/multi.json", (c) => { c.metadata.signers[0].stake += 1; });
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/CertificateHashUnmatch/);
        });
        test("altered protocol message with the hash recomputed by the forger", async () => {
            const c = await edited("preview/cdb.json", (c) => { c.protocol_message.message_parts.cardano_database_merkle_root = "00".repeat(32); });
            c.hash = computeCertificateHash(c); // the content hash alone is not a signature
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/CertificateProtocolMessageUnmatch/);
        });
        test("re-signed message hash but no matching STM signature", async () => {
            const c = await edited("preview/cdb.json", (c) => { c.protocol_message.message_parts.cardano_database_merkle_root = "00".repeat(32); });
            c.signedMessage = protocolMessageHash(c.protocolMessage);
            c.hash = computeCertificateHash(c);
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/VerifyMultiSignature/);
        });
        test("epoch differs from current_epoch part", async () => {
            const c = await edited("preview/cdb.json", (c) => { c.epoch = 1443; });
            c.hash = computeCertificateHash(c);
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/CertificateEpochUnmatch/);
        });
        test("certificate chaining to itself", async () => {
            const c = await edited("preview/cdb.json", (c) => { c.previous_hash = c.hash; });
            expect(() => verifyStandardCertificateIntegrity(c)).toThrow(/CertificateChainInfiniteLoop/);
        });
        test("wrong predecessor", async () => {
            expect(() => verifyStandardCertificate(cert_("preview/cdb.json"), cert_("mainnet/multi-previous.json"))).toThrow(/CertificateChainMissingEpoch|PreviousHashUnmatch/);
        });
        test("AVK chaining: next AVK of the predecessor differs", async () => {
            const prev = await edited("preview/hop1.json", (c) => {
                c.protocol_message.message_parts.next_aggregate_verification_key = (parseJsonLossless(textSync("preview/cdb.json")) as any).aggregate_verification_key;
            });
            expect(() => verifyStandardCertificate(cert_("preview/hop2.json"), prev)).toThrow(/CertificateChainAVKUnmatch/);
        });
        test("protocol parameters chaining: next parameters of the predecessor differ", async () => {
            const prev = await edited("preview/hop1.json", (c) => { c.protocol_message.message_parts.next_protocol_parameters = "00".repeat(32); });
            expect(() => verifyStandardCertificate(cert_("preview/hop2.json"), prev)).toThrow(/CertificateChainProtocolParametersUnmatch/);
        });
        test("epoch gap", async () => {
            const prev = await edited("preview/hop1.json", (c) => { c.epoch = 1129; });
            expect(() => verifyStandardCertificate(cert_("preview/hop2.json"), prev)).toThrow(/CertificateChainMissingEpoch/);
        });
        test("flipped bit in the genesis signature", async () => {
            const g = await edited("preview/genesis.json", (c) => { c.genesis_signature = flipHex(c.genesis_signature, 5); });
            g.hash = computeCertificateHash(g);
            expect(() => verifyGenesisCertificate(g, decodeGenesisVerificationKey(textSync("preview/genesis.vkey")))).toThrow(/CertificateGenesis/);
        });
        test("a standard certificate passed as genesis and the reverse", async () => {
            const vk = decodeGenesisVerificationKey(await text("preview/genesis.vkey"));
            expect(() => verifyGenesisCertificate(cert_("preview/hop1.json"), vk)).toThrow(/InvalidGenesisCertificateProvided/);
            expect(() => verifyStandardCertificateIntegrity(cert_("preview/genesis.json"))).toThrow(/InvalidStandardCertificateProvided/);
        });
    });
});

function textSync(rel: string): string {
    return readFileSync(join(FIX, rel), "utf8");
}
function cert_(rel: string): Certificate {
    return parseCertificate(textSync(rel));
}
