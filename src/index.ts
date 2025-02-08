import { parseTopology } from "./parseTopology";
import { runNode } from "./runNode";

void async function main()
{
    const topology = parseTopology("./topology.json");
    const networkMagic = 1; // preprod
    
    void await runNode({
        topology,
        networkMagic
    });
}();
