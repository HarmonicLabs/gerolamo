/**
 * Mithril aggregator configuration and small helpers shared by the pure-TS
 * client (httpClient.ts) and the bootstrap: network endpoints, genesis
 * verification key fetch, snapshot selection. The WASM client wrapper
 * (@mithril-dev/mithril-client-wasm) is gone; pure TS is the only engine.
 */

import type {
    MithrilCdbListItem,
    MithrilCdbSnapshot,
    MithrilCertificate,
    MithrilNetwork,
    MithrilNetworkConfig,
} from "./types";

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
