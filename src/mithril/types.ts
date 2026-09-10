/**
 * Mithril Cardano DB types (aggregator shapes).
 *
 * Client role (official): list/show/verify Mithril-certified artifacts.
 * Gerolamo uses Cardano DB snapshots for immutable chunk bootstrap only.
 * Ancillary UTxO extract remains blocked (A2) — see src/state/mithril.ts.
 */

export type MithrilNetwork = "preprod" | "preview" | "mainnet";

/** Engine for mithril-bootstrap: pure TypeScript (production) or the external mithril-client binary. */
export type MithrilEngine = "ts" | "bin";

export type MithrilBeacon = {
    epoch: number;
    immutable_file_number: number;
};

/** Location entry from artifact digests / immutables / ancillary. */
export type MithrilLocation = {
    type: string;
    /** Plain URL or cloud template object. */
    uri: string | { Template?: string; template?: string };
    compression_algorithm?: string;
};

export type MithrilCdbListItem = {
    hash: string;
    merkle_root: string;
    beacon: MithrilBeacon;
    certificate_hash: string;
    total_db_size_uncompressed: number;
    cardano_node_version: string;
    created_at: string;
};

export type MithrilCdbSnapshot = MithrilCdbListItem & {
    network?: string;
    digests?: {
        size_uncompressed?: number;
        locations: MithrilLocation[];
    };
    immutables?: {
        average_size_uncompressed?: number;
        locations: MithrilLocation[];
    };
    ancillary?: {
        size_uncompressed?: number;
        locations: MithrilLocation[];
    };
};

export type MithrilCertificate = {
    hash: string;
    previous_hash?: string | null;
    epoch?: number;
    signed_entity_type?: unknown;
    metadata?: unknown;
    protocol_message?: unknown;
    signed_message?: string;
    aggregate_verification_key?: string;
    multi_signature?: string;
    genesis_signature?: string;
};

export type MithrilNetworkConfig = {
    network: MithrilNetwork;
    aggregator: string;
    genesisVkeyUrl: string;
    runMode: string;
};

export type MithrilBootstrapOptions = {
    network: string;
    downloadDir: string;
    /** Snapshot hash or "latest". */
    digest?: string;
    engine?: MithrilEngine;
    /** External mithril-client path (bin engine). */
    clientBin?: string;
    aggregator?: string;
    genesisVkey?: string;
    skipDownload?: boolean;
    skipApply?: boolean;
    /** First immutable file number (inclusive). */
    fromChunk?: number;
    /** Last immutable file number (inclusive). Default = snapshot beacon max. */
    toChunk?: number;
    /** Download only these many chunks from fromChunk (smoke). */
    limitChunks?: number;
    /** Download ancillary (not applied — A2 blocked). */
    includeAncillary?: boolean;
    /** Store the certified blocks only (block store for a local relay); no ledger apply. */
    blocksOnly?: boolean;
    /**
     * Snapshot bootstrap: verify the ancillary manifest signature, store the certified blocks
     * (implies blocksOnly and includeAncillary), then import the UTxO tables and the
     * NewEpochState into the ledger tables (import-utxo + import-state).
     */
    ledgerState?: boolean;
    /** Ancillary verification key (hex-of-JSON, path or URL); default: the network's published key. */
    ancillaryVkey?: string;
    /** Progress JSON for the dashboard (default `<downloadDir>/progress.json`). */
    progressFile?: string;
    /** Parallel chunk downloads (default 8). */
    downloadConcurrency?: number;
};

export type MithrilBootstrapResult = {
    engine: MithrilEngine;
    snapshotHash: string;
    certificateHash: string;
    immutableDir: string | null;
    /** Ancillary ledger dir if --include-ancillary landed files; UTxO still A2 blocked. */
    ancillaryDir: string | null;
    downloadedChunks: number[];
    appliedChunks: number[];
    verified: boolean;
};
