import { Multiplexer, HandshakeClient, HandshakeAcceptVersion } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "./logger";

export async function performHandshake( mplexers: Multiplexer[], networkMagic: number ): Promise<Multiplexer[]>
{
    const results = await Promise.all(
        mplexers.map(mplexer => {
            const remoteAddress = (mplexer.socket.unwrap() as any).remoteAddress;
            return new Promise<Multiplexer | undefined>(async (resolve) => {
                
                mplexer.once("error", err => {
                    logger.warn("could not connect to remote socket.", remoteAddress);
                    logger.error(err);
                    resolve(undefined);
                });
                
                const client = new HandshakeClient(mplexer);
                const result = client.propose(networkMagic);
                if(!(result instanceof HandshakeAcceptVersion))
                {
                    logger.warn("could not connect to remote socket.", remoteAddress);
                    resolve(undefined);
                }

                resolve(mplexer);
            });
        })
    );
    return results.filter( result => result !== undefined && !result.socket.isClosed() ) as Multiplexer[];
}