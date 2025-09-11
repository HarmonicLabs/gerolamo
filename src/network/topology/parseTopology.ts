// import { existsSync, readFileSync } from "fs";
import {
    adaptLegacyTopology,
    isLegacyTopology,
    isTopology,
    Topology,
} from "./topology";

export async function parseTopology(path: string): Promise<Topology> {
    const topoFile = Bun.file(path);
    if (!(await topoFile.exists())) {
        throw new Error("missing topology file at " + path);
    }

    let topology = JSON.parse(await topoFile.text());

    topology = isLegacyTopology(topology)
        ? adaptLegacyTopology(topology)
        : topology;

    if (!isTopology(topology)) {
        throw new Error("invalid topology file at " + path);
    }

    return topology;
}
