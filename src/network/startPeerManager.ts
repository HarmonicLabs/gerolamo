import {
    addPeerToManager,
    createPeerManager,
    initPeerManager,
    PeerManagerState,
    peerSyncCurrentTasks,
} from "./PeerManager";
import { logger } from "../utils/logger";

export async function startPeerManager(
    networkMagic: number,
): Promise<PeerManagerState> {
    const peerManagerState = createPeerManager();
    await initPeerManager(peerManagerState, networkMagic);

    // Get topology from peerManagerState (already loaded and validated)
    const topology = peerManagerState.topology;

    // Add bootstrap peers concurrently
    if (topology.bootstrapPeers) {
        const bootstrapPromises = topology.bootstrapPeers.flatMap((ap) => [
            addPeerToManager(peerManagerState, ap.address, ap.port, "bootstrap")
                .catch((error) => {
                    logger.error(
                        `Failed to add bootstrap peer ${ap.address}:${ap.port}`,
                        error,
                    );
                }),
            addPeerToManager(peerManagerState, ap.address, ap.port, "hot")
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
                addPeerToManager(peerManagerState, ap.address, ap.port, "hot")
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
    await peerSyncCurrentTasks(peerManagerState);

    logger.debug("PeerManager started successfully");
    return peerManagerState;
}
