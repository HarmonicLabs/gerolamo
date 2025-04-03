import { runNode } from "./runNode";

export * from "./NodeConfig";
export * from "./parseTopology";

export async function Main() {
    return runNode();
}
