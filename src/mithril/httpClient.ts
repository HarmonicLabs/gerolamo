/**
 * Production Mithril client: HTTP aggregator + pure-TS certificate chain verification
 * (src/mithril/verify, a port of mithril-common's MithrilCertificateVerifier with full STM
 * multi-signature checks).
 *
 * This is the only in-process engine; `--engine bin` shells out to mithril-client.
 */
import type {
    MithrilCdbListItem,
    MithrilCdbSnapshot,
    MithrilCertificate,
    MithrilNetwork,
} from "./types";
import { fetchGenesisVkey, networkConfig, selectSnapshot } from "./client";
import { parseJsonLossless } from "./verify/json";
import type { Certificate } from "./verify/certificate";
import {
    aggregatorCertificateRetriever,
    decodeGenesisVerificationKey,
    verifyCertificateChain,
    type ChainHop,
    type ChainVerifyResult,
} from "./verify/verifier";

export type TsMithrilClient = {
    aggregator: string;
    network: MithrilNetwork;
    genesisVkey: string;
    listCardanoDatabaseV2(): Promise<MithrilCdbListItem[]>;
    getCardanoDatabaseV2(hash: string): Promise<MithrilCdbSnapshot>;
    fetchCertificate(hash: string): Promise<MithrilCertificate>;
    /**
     * Verify the certificate and its chain back to the genesis certificate (signed with the
     * network's genesis key). Throws a CertificateError on the first failed check.
     */
    verifyCertificateChain(certificateHash: string, opts?: { onHop?: (hop: ChainHop) => void }): Promise<{
        cert: MithrilCertificate;
        certificate: Certificate;
        chain: ChainVerifyResult;
    }>;
};

async function httpJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    return parseJsonLossless(await res.text()) as T;
}

export async function createTsMithrilClient(opts: {
    network?: string;
    aggregator?: string;
    genesisVkey?: string;
    genesisVkeyUrl?: string;
}): Promise<TsMithrilClient> {
    const cfg = networkConfig(opts.network ?? "preprod");
    const aggregator = (opts.aggregator || cfg.aggregator).replace(/\/$/, "");

    let genesisKey = opts.genesisVkey?.trim() || "";
    // --genesis-vkey takes a key, a file path or a URL.
    if (genesisKey && (genesisKey.startsWith("http") || genesisKey.includes("/") || genesisKey.includes("."))) {
        genesisKey = await fetchGenesisVkey(genesisKey);
    }
    if (!genesisKey) {
        const envKey = process.env.GENESIS_VERIFICATION_KEY?.trim();
        if (envKey && envKey.length > 64 && !envKey.includes("/") && !envKey.startsWith("http")) {
            genesisKey = envKey;
        } else if (envKey && (envKey.startsWith("http") || envKey.includes("/"))) {
            genesisKey = await fetchGenesisVkey(envKey);
        } else {
            genesisKey = await fetchGenesisVkey(
                opts.genesisVkeyUrl ||
                    process.env.GENESIS_VERIFICATION_KEY_URL ||
                    cfg.genesisVkeyUrl,
            );
        }
    }

    const retrieve = aggregatorCertificateRetriever(aggregator);
    const genesisVkeyBytes = decodeGenesisVerificationKey(genesisKey);

    return {
        aggregator,
        network: cfg.network,
        genesisVkey: genesisKey,
        async listCardanoDatabaseV2() {
            const list = await httpJson<MithrilCdbListItem[]>(
                `${aggregator}/artifact/cardano-database`,
            );
            if (!Array.isArray(list)) {
                throw new Error("HTTP list cardano-database returned non-array");
            }
            return list;
        },
        async getCardanoDatabaseV2(hash: string) {
            const detail = await httpJson<MithrilCdbSnapshot>(
                `${aggregator}/artifact/cardano-database/${hash}`,
            );
            if (!detail || typeof detail !== "object" || !detail.hash) {
                throw new Error(`HTTP get cardano-database/${hash} returned empty`);
            }
            return detail;
        },
        async fetchCertificate(hash: string) {
            return (await retrieve(hash)).raw as MithrilCertificate;
        },
        async verifyCertificateChain(certificateHash: string, opts?: { onHop?: (hop: ChainHop) => void }) {
            const certificate = await retrieve(certificateHash);
            if (certificate.hash !== certificateHash) {
                throw new Error(`certificate ${certificateHash}: aggregator returned ${certificate.hash}`);
            }
            const chain = await verifyCertificateChain(certificate, {
                genesisVkey: genesisVkeyBytes,
                retrieve,
                onHop: opts?.onHop,
            });
            return { cert: certificate.raw as MithrilCertificate, certificate, chain };
        },
    };
}

export { selectSnapshot };
