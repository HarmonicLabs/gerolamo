import { connect } from "net";
import { parseTopology } from "./parseTopology";
import { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { performHandshake } from "./performHandshake";
import { runNode } from "./runNode";
import { logger } from "./logger";

void async function main()
{
    const topology = parseTopology("./topology.json");
    const networkMagic = 1; // preprod
    const mplexers: Multiplexer[] = 
        topology.localRoots.concat( topology.publicRoots )
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

    void await performHandshake( mplexers, networkMagic );
    void await runNode( mplexers, 10 );
}();
