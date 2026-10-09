/**
 * Certify a locally produced cardano-database snapshot against Mithril: pick the aggregator's
 * snapshot for an immutable file number the local store has complete, verify its certificate
 * chain to the genesis key (keeping every certificate so the node can serve the chain), then let
 * the producer check that the local Merkle root is the one that certificate signed.
 */

import { fetchGenesisVkey, networkConfig } from "../client";
import { parseJsonLossless } from "../verify/json";
import type { Certificate } from "../verify/certificate";
import { aggregatorCertificateRetriever, decodeGenesisVerificationKey, verifyCertificateChain, type ChainVerifyResult } from "../verify/verifier";
import type { MithrilCdbListItem } from "../types";
import { lastCompletedImmutable, listImmutableFiles } from "./digests";
import { produceCardanoDatabaseSnapshot, type ProduceResult } from "./produce";
import type { ArtifactStore } from "./store";

export type CertifiedTarget = { item: MithrilCdbListItem; certificate: Certificate; chain: Certificate[]; verify: ChainVerifyResult };

/** The newest aggregator snapshot whose beacon is <= `lastCompleted` (or exactly `immutable`), with its verified chain. */
export async function findCertifiedTarget(o: { aggregator: string; genesisVkey: string; lastCompleted: number; immutable?: number; log?: (m: string) => void }): Promise<CertifiedTarget> {
    const base = o.aggregator.replace(/\/$/, "");
    const res = await fetch(`${base}/artifact/cardano-database`);
    if (!res.ok) throw new Error(`GET ${base}/artifact/cardano-database: HTTP ${res.status}`);
    const list = parseJsonLossless(await res.text()) as MithrilCdbListItem[];
    const fits = list.filter((s) => (o.immutable != null ? s.beacon.immutable_file_number === o.immutable : s.beacon.immutable_file_number <= o.lastCompleted));
    fits.sort((a, b) => b.beacon.immutable_file_number - a.beacon.immutable_file_number);
    const item = fits[0];
    if (!item) {
        const range = list.length ? `${list[list.length - 1]!.beacon.immutable_file_number}..${list[0]!.beacon.immutable_file_number}` : "none";
        throw new Error(`no certified snapshot for ${o.immutable != null ? `immutable ${o.immutable}` : `immutable <= ${o.lastCompleted}`} (aggregator lists ${range})`);
    }
    const fetchCert = aggregatorCertificateRetriever(base);
    const chain: Certificate[] = [];
    const retrieve = async (h: string) => {
        const c = await fetchCert(h);
        chain.push(c);
        return c;
    };
    const certificate = await retrieve(item.certificate_hash);
    o.log?.(`verifying certificate chain of ${certificate.hash} (snapshot e${item.beacon.epoch}/i${item.beacon.immutable_file_number})`);
    let n = 0;
    const verify = await verifyCertificateChain(certificate, {
        genesisVkey: decodeGenesisVerificationKey(o.genesisVkey),
        retrieve,
        onHop: () => {
            if (++n % 100 === 0) o.log?.(`  ${n} certificates verified`);
        },
    });
    o.log?.(`certificate chain OK: ${verify.hops.length} certificates to genesis ${verify.genesisHash}`);
    return { item, certificate, chain, verify };
}

export type ProduceCertifiedOptions = {
    immutableDir: string;
    store: ArtifactStore;
    network: string;
    aggregator?: string;
    /** Genesis verification key: the key itself, a path or a URL (default: the network's published key). */
    genesisVkey?: string;
    immutable?: number;
    archiveRange?: { from: number; to: number };
    log?: (m: string) => void;
};

export async function produceCertifiedSnapshot(o: ProduceCertifiedOptions): Promise<ProduceResult & { target: CertifiedTarget }> {
    const cfg = networkConfig(o.network);
    const aggregator = o.aggregator ?? cfg.aggregator;
    let vkey = o.genesisVkey ?? cfg.genesisVkeyUrl;
    if (vkey.startsWith("http") || vkey.includes("/")) vkey = await fetchGenesisVkey(vkey);
    const files = listImmutableFiles(o.immutableDir);
    const lastCompleted = lastCompletedImmutable(files);
    if (lastCompleted == null) throw new Error(`${o.immutableDir}: no complete immutable trio`);
    o.log?.(`${o.immutableDir}: immutable files complete up to ${lastCompleted}`);
    const target = await findCertifiedTarget({ aggregator, genesisVkey: vkey, lastCompleted, immutable: o.immutable, log: o.log });
    const r = await produceCardanoDatabaseSnapshot({
        immutableDir: o.immutableDir,
        store: o.store,
        network: o.network,
        beacon: { epoch: target.item.beacon.epoch, immutableFileNumber: target.item.beacon.immutable_file_number },
        certificate: target.certificate,
        certificateChain: target.chain,
        archiveRange: o.archiveRange,
        cardanoNodeVersion: target.item.cardano_node_version,
        log: o.log,
    });
    if (r.merkleRoot !== target.item.merkle_root) throw new Error(`local merkle root ${r.merkleRoot} differs from the aggregator's ${target.item.merkle_root}`);
    if (r.snapshot.hash !== target.item.hash) throw new Error(`local snapshot hash ${r.snapshot.hash} differs from the aggregator's ${target.item.hash}`);
    return { ...r, target };
}
