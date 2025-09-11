import * as Cli from "./cli";

if (process.argv.length > 0) {
    Cli.Main();
} else {
    throw new Error("No arguments passed");
}
