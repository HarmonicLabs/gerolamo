import { parentPort } from "node:worker_threads";
import { isPeerWorkerSetupKind, PeerWorkerSetupData } from "./messages";
import { NodeConfig } from "../NodeConfig";
import {
    BlockFetchClient,
    ChainSyncClient,
    Multiplexer,
    RealPoint,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../logger";
import { connect, Socket } from "node:net";
import { performHandshake } from "./performHandshake";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { TopologyAccessPoint } from "../../lib/topology";

let _initialized = false;

function accessPointToMultiplexer(aPoint: TopologyAccessPoint): Multiplexer {
    return new Multiplexer({
        connect: () => {
            logger.info(
                `Attempt connection to ${aPoint.address}:${aPoint.port}`,
            );
            return connect({
                host: aPoint.address,
                port: aPoint.port,
            });
        },
        protocolType: "node-to-node",
        initialListeners: { error: [logger.error] },
    });
}

function multiplexerToClients(multiplexer: Multiplexer) {
    return {
        chainSync: new ChainSyncClient(multiplexer),
        blockFetch: new BlockFetchClient(multiplexer),
    };
}

function chainSyncAddCallbacks(chainSync: ChainSyncClient) {
    chainSync.on("error", (err) => {
        logger.error(err);
        throw err;
    });

    chainSync.once("awaitReply", () =>
        logger.info(
            "Reached tip on peer:",
            chainSync.mplexer.socket.unwrap<Socket>().remoteAddress,
        ),
    );

    chainSync.on("rollForward", async (forward) => {
        // const hdr = MultiEraHeader.fromCbor(forward.getDataBytes());

        // TODO: first setup ledger-state as done in amaru
        // await validateMultiEraHeader(lState, hdr);

        logger.info("ChainSyncRollForward request:", forward);
        return chainSync.requestNext();
    });
    chainSync.on("rollBackwards", async (rollback) => {
        logger.warn("ChainSyncRollBack request:", rollback.point.toString());
    });
}

function blockFetchAddCallbacks(blockFetch: BlockFetchClient) {
    blockFetch.on("error", (err) => {
        logger.error(err);
        throw err;
    });
}

async function chainSyncInit(startPoint: RealPoint, client: ChainSyncClient) {
    await client.findIntersect([startPoint]);
    await client.requestNext();
}

parentPort?.on("message", async (message) => {
    if (!_initialized && isPeerWorkerSetupKind(message)) {
        const data = message.data as PeerWorkerSetupData;
        const conns = data.initialPeersConnections
            .map((root) => root.accessPoints.map(accessPointToMultiplexer))
            .flat();

        await Promise.all(
            conns.map((conn) =>
                performHandshake(data.config.networkMagic, conn),
            ),
        );

        const peers = conns.map(multiplexerToClients);
        for (const { chainSync, blockFetch } of peers) {
            chainSyncAddCallbacks(chainSync);
            blockFetchAddCallbacks(blockFetch);
        }

        const startPoint = new RealPoint({
            blockHeader: {
                hash: fromHex(
                    (data.config as NodeConfig).startPoint.blockHeader.hash,
                ),
                slotNumber: (data.config as NodeConfig).startPoint.blockHeader
                    .slot,
            },
        });

        await Promise.all(
            peers.map(({ chainSync }) => chainSyncInit(startPoint, chainSync)),
        );

        _initialized = true;
    }
});
