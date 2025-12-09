import { existsSync } from "fs";
import { readdirSync, statSync } from "fs";
import * as path from "node:path";

export class LMDBLedgerState {
    private snapshotRoot: string;
    private outputPath: string;

    constructor(snapshotRoot: string, outputPath: string) {
        this.snapshotRoot = snapshotRoot;
        this.outputPath = outputPath;
    }

    static async initFromSnapshotRoot(
        snapshotRoot: string,
        outputPath: string,
    ): Promise<LMDBLedgerState> {
        const state = new LMDBLedgerState(snapshotRoot, outputPath);
        await state.extractUTxO();
        return state;
    }

    private async extractUTxO(): Promise<void> {
        const ledgerDir = path.join(this.snapshotRoot, "ledger");
        if (!existsSync(ledgerDir)) {
            throw new Error(`Ledger directory not found at ${ledgerDir}`);
        }

        // Find the latest slot directory in ledger
        const slotDirs = readdirSync(ledgerDir)
            .map((name) => ({ name, path: path.join(ledgerDir, name) }))
            .filter((item) =>
                statSync(item.path).isDirectory() && /^\d+$/.test(item.name)
            )
            .sort((a, b) => parseInt(b.name) - parseInt(a.name));

        if (slotDirs.length === 0) {
            throw new Error("No slot directories found in ledger");
        }

        const latestSlotDir = slotDirs[0].path;

        // Dump the LMDB database
        const dumpPath = `${this.outputPath}.dump`;
        await this.runCommand(`mdb_dump -f ${dumpPath} ${latestSlotDir}`);

        // Load into new LMDB database
        await this.runCommand(`mdb_load -f ${dumpPath} ${this.outputPath}`);

        // Clean up dump file
        await this.runCommand(`rm ${dumpPath}`);
    }

    private async runCommand(cmd: string): Promise<void> {
        const proc = Bun.spawn(cmd.split(" "), {
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = await proc.exited;
        if (output !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`Command failed: ${cmd}\n${stderr}`);
        }
    }

    getOutputPath(): string {
        return this.outputPath;
    }
}
