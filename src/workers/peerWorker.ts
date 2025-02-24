import { MessagePort, parentPort } from "node:worker_threads";
import { LoadTracker } from "./utils/LoadTracker";
import { isPeerWorkerSetupKind } from "./messages/main/messages/PeerWorkerSetup";
import { SharedMempool } from "@harmoniclabs/shared-cardano-mempool-ts";
import { WorkerInfo } from "./messages/main/data/WokerInfo";
import { NodeConfig } from "../NodeConfig";
import { BlockFetchClient, ChainSyncClient, Multiplexer, RealPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../logger";
import { connect, Socket } from "node:net";
import { performHandshake } from "../performHandshake";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { MultiEraHeader } from "../../lib/ledgerExtension/multi-era/MultiEraHeader";

const loadTracker = new LoadTracker();

let workerId = -1;
let _initialized = false;
let mempool!: SharedMempool;
let lStatePort!: MessagePort;
const otherPeerWorkers: WorkerInfo[] = [];
const config: NodeConfig = {} as NodeConfig; 

const peers = new Array();

parentPort?.on("message", async (message) => {
    if( isPeerWorkerSetupKind( message ) )
    {
        const {
            workerId: _workerId,
            initialPeersConnections: peersInfos,
            config: _cfg,
            otherPeerWorkers: otherPeers,
            ledgerStateChainSelWorker,
            mempoolBuffer
        } = message.data;

        mempool = new SharedMempool( mempoolBuffer );
        lStatePort = ledgerStateChainSelWorker.port;
        otherPeerWorkers.push( ...otherPeers );
        Object.assign( config, _cfg );
        Object.freeze( config );
        workerId = _workerId;

        const startPoint = new RealPoint({
            blockHeader: {
                hash: fromHex( config.startPoint.blockHeader.hash ),
                slotNumber: config.startPoint.blockHeader.slot
            }
        });

         const connections: Multiplexer[] = peersInfos
        .map( root =>
            root.accessPoints.map( accessPoint => {
                const mplexer = new Multiplexer({
                    connect: () => {
                        logger.info(`Attempt connection to ${accessPoint.address}:${accessPoint.port}`);
                        return connect({
                            host: accessPoint.address,
                            port: accessPoint.port
                        });
                    },
                    protocolType: "node-to-node",
                    initialListeners: {
                        error: [ logger.error ],
                    }
                });
                return mplexer;
            })
        )
        .flat( 1 );
    
        void await performHandshake( connections, config.networkMagic );

        const peers = connections.map( mplexer => 
            ({ 
                chainSync: new ChainSyncClient( mplexer ),
                blockFetch: new BlockFetchClient( mplexer )
            })
        );
    
        for( const { chainSync, blockFetch } of peers )
        {
            chainSync.on("error", err => {
                logger.error( err );
                throw err;
            });
            blockFetch.on("error", err => {
                logger.error( err );
                throw err;
            });

            chainSync.once("awaitReply", () =>
                logger.info(
                    "reached tip on peer",
                    (chainSync.mplexer.socket.unwrap() as Socket).remoteAddress
                )
            );

            chainSync.on("rollForward", async forward => {

                const hdr = MultiEraHeader.fromCbor( forward.getDataBytes() );
        
                // TODO: first setup ledger-state as done in amaru
                await validateMultiEraHeader( lState, hdr );

                chainSync.requestNext();
            });
            chainSync.on("rollBackwards", async (rollback) => {

                logger.warn("rollback to", rollback.point.toString());
            });
        }
    
        await Promise.all(
            peers.map(
                async ({ chainSync: client }) => {
                    await client.findIntersect([ startPoint ]);
                    // rollback
                    await client.requestNext();
                }
            )
        );

        _initialized = true;
    }
});