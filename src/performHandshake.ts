import {
    Multiplexer,
    HandshakeClient,
    CardanoNetworkMagic,
    HandshakeAcceptVersion,
    HandshakeQueryReply,
    HandshakeRefuse,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "./logger";

export function performHandshake(
    mplexers: Multiplexer[],
    networkMagic: number = CardanoNetworkMagic.Preprod,
): Promise<(HandshakeAcceptVersion | HandshakeRefuse | HandshakeQueryReply)[]> {
    return Promise.all(
        mplexers.map((mplexer, i) => {
            const client = new HandshakeClient(mplexer);

            logger.info(`Performing handshake`);

            return client
                .propose({
                    networkMagic,
                    query: false,
                })
                .then((result) => {
                    logger.debug(i, "Handshake result: ", result);
                    client.terminate();
                    return result;
                });
        }),
    );
}
