import { PeerManager } from "./PeerManager";
import { logger } from "../utils/logger";

export async function startPeerManager(
    networkMagic: number,
): Promise<PeerManager> {
    const peerManager = new PeerManager();
    await peerManager.init(networkMagic);

    // Get topology from peerManager (already loaded and validated)
    const topology = peerManager.topology;

    // Add bootstrap peers concurrently
    if (topology.bootstrapPeers) {
        const bootstrapPromises = topology.bootstrapPeers.flatMap((ap) => [
            peerManager.addPeer(ap.address, ap.port, "bootstrap")
                .catch((error) => {
                    logger.error(
                        `Failed to add bootstrap peer ${ap.address}:${ap.port}`,
                        error,
                    );
                }),
            peerManager.addPeer(ap.address, ap.port, "hot")
                .catch((error) => {
                    logger.error(
                        `Failed to add hot peer ${ap.address}:${ap.port}`,
                        error,
                    );
                }),
        ]);
        await Promise.all(bootstrapPromises);
    }

    // Add local root peers concurrently
    if (topology.localRoots) {
        const localRootPromises = topology.localRoots.flatMap((root) =>
            root.accessPoints.map((ap) =>
                peerManager.addPeer(ap.address, ap.port, "hot")
                    .catch((error) => {
                        logger.error(
                            `Failed to add local root peer ${ap.address}:${ap.port}`,
                            error,
                        );
                    })
            )
        );
        await Promise.all(localRootPromises);
    }

    // Start sync for hot peers
    await peerManager.startPeerSync();

    logger.debug("PeerManager started successfully");
    return peerManager;
}
