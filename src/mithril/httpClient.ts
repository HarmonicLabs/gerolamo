/**
 * Production Mithril client — HTTP aggregator + pure-TS cert-chain verify.
 *
 * WASM (`createMithrilClient`) is debug/compare only (`--engine wasm|both`).
 */
import type {
    MithrilCdbListItem,
    MithrilCdbSnapshot,
    MithrilCertificate,
    MithrilNetwork,
} from "./types";
import { fetchGenesisVkey, networkConfig, selectSnapshot } from "./client";
import {
    pureTsFullChainStagesOk,
    pureTsVerifyCertificateChain,
    type PureTsVerifyResult,
} from "./dualRun";
import { createAggregatorCertificateFetcher } from "./pureTs/chain";

export type TsMithrilClient = {
    aggregator: string;
    network: MithrilNetwork;
    genesisVkey: string;
    listCardanoDatabaseV2(): Promise<MithrilCdbListItem[]>;
    getCardanoDatabaseV2(hash: string): Promise<MithrilCdbSnapshot>;
    fetchCertificate(hash: string): Promise<MithrilCertificate>;
    /**
     * Walk tip→genesis with the pure-TS verifier.
     * Throws if Stages 1–5d are not all green.
     */
    verifyCertificateChain(certificateHash: string): Promise<{
        cert: MithrilCertificate;
        pureTs: PureTsVerifyResult;
    }>;
};

async function httpJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    return (await res.json()) as T;
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

    const fetchRaw = createAggregatorCertificateFetcher(aggregator);
    const fetchCert = async (hash: string): Promise<MithrilCertificate | null> => {
        const c = await fetchRaw(hash);
        if (!c || typeof (c as MithrilCertificate).hash !== "string") return null;
        return c as MithrilCertificate;
    };

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
            const cert = await fetchCert(hash);
            if (!cert) throw new Error(`certificate ${hash} not found`);
            return cert;
        },
        async verifyCertificateChain(certificateHash: string) {
            const cert = await fetchCert(certificateHash);
            if (!cert) {
                throw new Error(`certificate ${certificateHash} not found`);
            }
            const pureTs = await pureTsVerifyCertificateChain(
                certificateHash,
                cert,
                {
                    fetcher: fetchCert,
                    genesisVkey: genesisKey,
                    runChainWalk: true,
                },
            );
            if (!pureTsFullChainStagesOk(pureTs)) {
                throw new Error(
                    `pure-TS cert-chain reject cert=${certificateHash}: ${pureTs.reason}`,
                );
            }
            return { cert, pureTs };
        },
    };
}

export { selectSnapshot };
