import { program } from "./cli";
import * as Cli from "./cli";

Cli.SyncNode();
program.action(async (options) => {
    await Cli.startNode(options.config);
});

program.parse(process.argv);
