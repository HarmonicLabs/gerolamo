/**
 * Mithril WASM client wrapper (@mithril-dev/mithril-client-wasm).
 *
 * Proven surface (0.10.8 node target, bun spike):
 *   - new MithrilClient(aggregator, genesis_vkey, options)
 *   - list_cardano_database_v2()
 *   - get_cardano_database_v2(hash)
 *   - verify_certificate_chain(certificate_hash)
 *   - verify_message_match_certificate(message, certificate)
 *
 * WASM does NOT multi-GB download_unpack — that is download.ts or external bin.
 * Phase 4 pure-TS STM is NOT implemented — dual-run scaffold keeps WASM as SoT.
 */

import type {
    MithrilCdbListItem,
    MithrilCdbSnapshot,
    MithrilCertificate,
    MithrilNetwork,
    MithrilNetworkConfig,
} from "./types";

/** Lazy-loaded WASM module class. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmMithrilClient = any;

let WasmCtor: (new (
    aggregator: string,
    genesisKey: string,
    options: unknown,
) => WasmMithrilClient) | null = null;

async function loadWasmCtor(): Promise<
    new (aggregator: string, genesisKey: string, options: unknown) => WasmMithrilClient
> {
    if (WasmCtor) return WasmCtor;
    // Node target: CommonJS-style exports.MithrilClient (no separate init required in 0.10.8)
    const mod = await import(
        "@mithril-dev/mithril-client-wasm/dist/node/mithril_client_wasm.js"
    );
    const Ctor = (mod as { MithrilClient?: unknown }).MithrilClient
        ?? (mod as { default?: { MithrilClient?: unknown } }).default?.MithrilClient;
    if (typeof Ctor !== "function") {
        throw new Error(
            "mithril-client-wasm: MithrilClient export missing — check package install",
        );
    }
    WasmCtor = Ctor as new (
        aggregator: string,
        genesisKey: string,
        options: unknown,
    ) => WasmMithrilClient;
    return WasmCtor;
}

export function networkConfig(network: string): MithrilNetworkConfig {
    const n = network.toLowerCase();
    if (n === "mainnet") {
        return {
            network: "mainnet",
            aggregator:
                "https://aggregator.release-mainnet.api.mithril.network/aggregator",
            genesisVkeyUrl:
                "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/release-mainnet/genesis.vkey",
            runMode: "release-mainnet",
        };
    }
    // preprod / testnet default
    return {
        network: "preprod",
        aggregator:
            "https://aggregator.release-preprod.api.mithril.network/aggregator",
        genesisVkeyUrl:
            "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/release-preprod/genesis.vkey",
        runMode: "release-preprod",
    };
}

export async function fetchGenesisVkey(
    pathOrUrl: string,
): Promise<string> {
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
        const res = await fetch(pathOrUrl);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch genesis vkey: HTTP ${res.status} ${pathOrUrl}`,
            );
        }
        return (await res.text()).trim();
    }
    const file = Bun.file(pathOrUrl);
    if (!(await file.exists())) {
        throw new Error(`Genesis vkey not found at ${pathOrUrl}`);
    }
    return (await file.text()).trim();
}

export type GerolamoMithrilClient = {
    aggregator: string;
    network: MithrilNetwork;
    raw: WasmMithrilClient;
    listCardanoDatabaseV2(): Promise<MithrilCdbListItem[]>;
    getCardanoDatabaseV2(hash: string): Promise<MithrilCdbSnapshot>;
    verifyCertificateChain(certificateHash: string): Promise<MithrilCertificate>;
    /**
     * WASM: verify a protocol message matches the certificate.
     * Call after computing message from artifact digests (when available).
     */
    verifyMessageMatchCertificate(
        message: unknown,
        certificate: MithrilCertificate | unknown,
    ): Promise<boolean>;
    free(): void;
};

/**
 * Create an in-process Mithril client (WASM).
 * Caller should free() when done if long-lived process holds many clients.
 */
export async function createMithrilClient(opts: {
    network?: string;
    aggregator?: string;
    genesisVkey?: string;
    genesisVkeyUrl?: string;
}): Promise<GerolamoMithrilClient> {
    const cfg = networkConfig(opts.network ?? "preprod");
    const aggregator = opts.aggregator || cfg.aggregator;
    let genesisKey = opts.genesisVkey?.trim() || "";
    if (!genesisKey) {
        const gvk =
            opts.genesisVkeyUrl ||
            process.env.GENESIS_VERIFICATION_KEY_URL ||
            cfg.genesisVkeyUrl;
        // GENESIS_VERIFICATION_KEY may already be the raw key
        if (process.env.GENESIS_VERIFICATION_KEY?.trim() && !opts.genesisVkeyUrl) {
            const envKey = process.env.GENESIS_VERIFICATION_KEY.trim();
            // Heuristic: hex-ish long string = key; otherwise treat as path/url only if looks like path
            if (envKey.length > 64 && !envKey.includes("/") && !envKey.startsWith("http")) {
                genesisKey = envKey;
            } else if (envKey.startsWith("http") || envKey.includes("/")) {
                genesisKey = await fetchGenesisVkey(envKey);
            } else {
                genesisKey = envKey;
            }
        } else {
            genesisKey = await fetchGenesisVkey(gvk);
        }
    }

    const Ctor = await loadWasmCtor();
    const raw = new Ctor(aggregator, genesisKey, {});

    return {
        aggregator,
        network: cfg.network,
        raw,
        async listCardanoDatabaseV2() {
            const list = await raw.list_cardano_database_v2();
            if (!Array.isArray(list)) {
                throw new Error("list_cardano_database_v2 returned non-array");
            }
            return list as MithrilCdbListItem[];
        },
        async getCardanoDatabaseV2(hash: string) {
            const detail = await raw.get_cardano_database_v2(hash);
            if (!detail || typeof detail !== "object") {
                throw new Error(`get_cardano_database_v2(${hash}) returned empty`);
            }
            return detail as MithrilCdbSnapshot;
        },
        async verifyCertificateChain(certificateHash: string) {
            const cert = await raw.verify_certificate_chain(certificateHash);
            if (!cert || typeof cert !== "object") {
                throw new Error(
                    `verify_certificate_chain(${certificateHash}) failed / empty`,
                );
            }
            return cert as MithrilCertificate;
        },
        async verifyMessageMatchCertificate(message, certificate) {
            const ok = await raw.verify_message_match_certificate(
                message,
                certificate,
            );
            return ok === true || ok === 1 || ok === "true";
        },
        free() {
            try {
                raw.free?.();
            } catch {
                /* ignore */
            }
        },
    };
}

/** Pick snapshot by hash or latest (index 0 from aggregator list). */
export function selectSnapshot(
    list: MithrilCdbListItem[],
    digest: string | undefined,
): MithrilCdbListItem {
    if (!list.length) {
        throw new Error("No Cardano DB snapshots available from aggregator");
    }
    const d = (digest || "latest").toLowerCase();
    if (d === "latest") return list[0]!;
    const found = list.find((s) => s.hash === digest);
    if (!found) {
        throw new Error(
            `Snapshot digest not found: ${digest}. Use "latest" or a full hash from list.`,
        );
    }
    return found;
}
