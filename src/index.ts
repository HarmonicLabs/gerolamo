import { connect } from "net";
import { parseTopology } from "./parseTopology";
import { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { performHandshake } from "./performHandshake";
import { runNode } from "./runNode";
import { logger } from "./logger";

void async function main()
{
    void await runNode();
}();
