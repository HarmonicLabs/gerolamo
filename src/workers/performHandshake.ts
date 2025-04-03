import {
    Multiplexer,
    HandshakeClient,
    CardanoNetworkMagic,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../utils/logger";

export const performHandshake = async (
    networkMagic: number = CardanoNetworkMagic.Preprod,
    mp: Multiplexer,
) => {
    const client = new HandshakeClient(mp);
    logger.info(`Performing handshake`);

    return client
        .propose({
            networkMagic,
            query: false,
        })
        .then((result) => {
            logger.debug("Handshake result: ", result);
            client.terminate();
            return result;
        });
};
