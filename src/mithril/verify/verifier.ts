/**
 * Mithril certificate chain verification: @harmoniclabs/mithril-ts core.
 *
 * Gerolamo keeps one adapter: `aggregatorCertificateRetriever`, the HTTP `/certificate/{hash}`
 * retriever its client/bootstrap call sites already use. Everything else (chain walk, standard
 * and genesis checks, genesis key decoding, strict Ed25519) is the library's.
 */

import { parseCertificate, type Certificate } from "@harmoniclabs/mithril-ts";

export {
    decodeGenesisVerificationKey,
    ed25519VerifyStrict,
    verifyCertificateChain,
    verifyGenesisCertificate,
    verifyStandardCertificate,
    verifyStandardCertificateIntegrity,
    type CertificateRetriever,
    type ChainHop,
    type ChainVerifyOptions,
    type ChainVerifyResult,
} from "@harmoniclabs/mithril-ts";

/** A retriever over an aggregator's `/certificate/{hash}` route (lossless JSON). */
export function aggregatorCertificateRetriever(aggregatorUrl: string, fetchImpl: typeof fetch = fetch): (hash: string) => Promise<Certificate> {
    const base = aggregatorUrl.replace(/\/$/, "");
    return async (hash: string) => {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad certificate hash ${JSON.stringify(hash)}`);
        const res = await fetchImpl(`${base}/certificate/${hash}`);
        if (!res.ok) throw new Error(`GET ${base}/certificate/${hash}: HTTP ${res.status}`);
        return parseCertificate(await res.text());
    };
}
