import color from "picocolors";
import { rotateIfNeeded } from "./logRotate";
import * as fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4,
}

Object.freeze(LogLevel);

export type LogLevelString = keyof typeof LogLevel & string;

export function isLogLevelString(str: string): str is LogLevelString {
    return (
        typeof str === "string" &&
        typeof LogLevel[str.toUpperCase() as any] === "number"
    );
}

export function logLevelFromString(str: string): LogLevel {
    if (typeof str !== "string") return LogLevel.INFO;
    return (
        LogLevel[str.toUpperCase() as any] as any as LogLevel | undefined
    ) ?? LogLevel.INFO;
}

export interface LoggerConfig {
    logLevel: LogLevel;
    logDirectory?: string;
    logToFile?: boolean;
    logToConsole?: boolean;
    bufferedLevels?: string[];
    batchSize?: number;
    flushDelayMs?: number;
    /** Rotate a level's .jsonl file when it exceeds this many bytes (default 64 MiB; 0 = never). */
    maxFileBytes?: number;
    /** Rotated generations to keep (default 5). */
    keepFiles?: number;
}

const defaultLoggerConfig: LoggerConfig = {
    logLevel: LogLevel.INFO,
    logDirectory: undefined,
    // Off until the node applies its config (setLogConfig from config.json `logs`).
    // With `true` here every `bun test` run and every script that imported the
    // logger appended debug output to ./src/store/logs/preprod/ — 100 GB of it.
    logToFile: false,
    logToConsole: true,
    bufferedLevels: ["debug", "info"],
    batchSize: 1000,
    flushDelayMs: 500,
};

export class Logger {
    private config: LoggerConfig = { ...defaultLoggerConfig };
    private _colors: boolean = true;
    private queues: Record<string, string[]> = {};
    private flushTimers: Record<string, NodeJS.Timeout> = {};
    private bufferedLevels: string[] = ["debug", "info"];
    private batchSize: number = 1000;
    private flushDelayMs: number = 500;
    private recentLogs: Array<
        { timestamp: string; level: string; args: any[] }
    > = [];
    private readonly MAX_RECENT_LOGS = 100;

    constructor(config?: Partial<LoggerConfig>) {
        let initConfig = { ...defaultLoggerConfig };
        if (config) {
            const processed = { ...config };
            if (typeof processed.logLevel === "string") {
                processed.logLevel = logLevelFromString(processed.logLevel);
            }
            initConfig = { ...initConfig, ...processed };
        }
        this.config = initConfig;
        this.updatePaths();
        this.bufferedLevels = initConfig.bufferedLevels ?? ["debug", "info"];
        this.batchSize = initConfig.batchSize ?? 1000;
        this.flushDelayMs = initConfig.flushDelayMs ?? 500;
    }

    private updatePaths() {
        if (!this.config.logToFile) return; // no directory or empty files unless file logging is on
        const network = process.env.NETWORK ?? "preprod";
        const dir = this.config.logDirectory || `./src/store/logs/${network}/`;
        fs.mkdirSync(dir, { recursive: true });
        const levels = [
            "debug",
            "info",
            "warn",
            "error",
            "mempool",
            "rollback",
        ];
        for (const level of levels) {
            const logFilePath = path.join(dir, `${level}.jsonl`);
            if (!fs.existsSync(logFilePath)) {
                fs.writeFileSync(logFilePath, "");
            }
        }
    }

    public setLogConfig(config: Partial<LoggerConfig>) {
        const processedConfig = { ...config };
        if (typeof processedConfig.logLevel === "string") {
            processedConfig.logLevel = logLevelFromString(
                processedConfig.logLevel,
            );
        }
        Object.assign(this.config, processedConfig);
        this.updatePaths();
        this.bufferedLevels = this.config.bufferedLevels ?? ["debug", "info"];
        this.batchSize = this.config.batchSize ?? 1000;
        this.flushDelayMs = this.config.flushDelayMs ?? 500;
    }

    get logLevel() {
        return this.config.logLevel;
    }

    useColors(enable: boolean = true) {
        this._colors = enable;
    }

    canDebug(): boolean {
        return this.logLevel <= LogLevel.DEBUG;
    }
    canInfo(): boolean {
        return this.logLevel <= LogLevel.INFO;
    }
    canWarn(): boolean {
        return this.logLevel <= LogLevel.WARN;
    }
    canError(): boolean {
        return this.logLevel <= LogLevel.ERROR;
    }
    canMempool(): boolean {
        return this.canInfo();
    }
    canRollback(): boolean {
        return this.canInfo();
    }

    setLogLevel(level: LogLevel) {
        this.config.logLevel = level;
    }

    /** Bytes written per file since the last stat; rotation decisions do not stat per line. */
    private fileSizes = new Map<string, number>();

    private rotate(logFilePath: string, addBytes: number): void {
        const max = this.config.maxFileBytes ?? 64 * 1024 * 1024;
        if (!(max > 0)) return;
        const keep = this.config.keepFiles ?? 5;
        let size = this.fileSizes.get(logFilePath);
        if (size == null) {
            try {
                size = fs.statSync(logFilePath).size;
            } catch {
                size = 0;
            }
        }
        if (size > 0 && size + addBytes > max && rotateIfNeeded(logFilePath, 1, keep)) size = 0;
        this.fileSizes.set(logFilePath, size + addBytes);
    }

    private getQueue(level: string): string[] {
        return this.queues[level] ??= [];
    }

    private scheduleFlush(level: string): void {
        if (this.flushTimers[level]) return;
        this.flushTimers[level] = setTimeout(() => {
            this.flushQueue(level);
        }, this.flushDelayMs);
    }

    private async flushQueue(level: string): Promise<void> {
        const queue = this.getQueue(level);
        if (queue.length === 0) return;
        const network = process.env.NETWORK ?? "preprod";
        const logDir = this.config.logDirectory ||
            `./src/store/logs/${network}/`;
        const logFilePath = path.join(logDir, `${level.toLowerCase()}.jsonl`);
        try {
            const chunk = queue.join("");
            this.rotate(logFilePath, Buffer.byteLength(chunk));
            await fsPromises.appendFile(logFilePath, chunk);
            queue.length = 0;
        } catch (err) {
            console.error(`Log flush failed for ${level}:`, err);
        } finally {
            if (this.flushTimers[level]) {
                clearTimeout(this.flushTimers[level]);
                delete this.flushTimers[level];
            }
        }
    }

    public async flushAll(): Promise<void> {
        await Promise.all(
            Object.keys(this.queues).map((l) => this.flushQueue(l as string)),
        );
    }

    private recordRecent(level: string, stuff: any[]) {
        this.recentLogs.push({
            timestamp: new Date().toISOString(),
            level,
            args: stuff,
        });
        if (this.recentLogs.length > this.MAX_RECENT_LOGS) {
            this.recentLogs.shift();
        }
    }

    public getRecentLogs(
        numLines: number = 20,
        minLevel: string = "DEBUG",
    ): Array<{ timestamp: string; level: string; message: string }> {
        const priority: Record<string, number> = {
            DEBUG: 0,
            INFO: 1,
            WARN: 2,
            ERROR: 3,
            MEMPOOL: 1,
            ROLLBACK: 1,
        };
        const minPri = priority[minLevel] ?? 0;
        const filteredRecent = this.recentLogs.filter((log) =>
            (priority[log.level] ?? 0) >= minPri
        );
        return filteredRecent.slice(-numLines).reverse().map((
            { timestamp, level, args },
        ) => ({
            timestamp: new Date(timestamp).toLocaleTimeString("en-US", {
                hour12: false,
            }),
            level,
            message: args.map((arg: any) => {
                if (typeof arg === "string") return arg;
                try {
                    const jsonStr = JSON.stringify(
                        arg,
                        (k, v) => typeof v === "bigint" ? v.toString() : v,
                    );
                    return jsonStr.slice(0, 120) +
                        (jsonStr.length > 120 ? "..." : "");
                } catch {
                    return String(arg).slice(0, 120) + "...";
                }
            }).join(" "),
        }));
    }

    private appendLog(level: string, stuff: any[]) {
        const network = process.env.NETWORK ?? "preprod";
        const logDir = this.config.logDirectory ||
            `./src/store/logs/${network}/`;
        const logFilePath = path.join(logDir, `${level.toLowerCase()}.jsonl`);
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            args: stuff.map((arg: any) => {
                if (arg instanceof Error) {
                    return {
                        message: arg.message,
                        stack: arg.stack,
                        name: arg.name,
                    };
                }
                if (typeof arg === "bigint") {
                    return arg.toString();
                }
                try {
                    return JSON.parse(
                        JSON.stringify(
                            arg,
                            (k, v) => typeof v === "bigint" ? v.toString() : v,
                        ),
                    );
                } catch {
                    return String(arg);
                }
            }),
        };
        const line = JSON.stringify(entry) + "\n";
        const lowerLevel = level.toLowerCase();
        if (!this.bufferedLevels.includes(lowerLevel)) {
            // Use async append for non-buffered levels too (avoid blocking event loop)
            this.rotate(logFilePath, Buffer.byteLength(line));
            fsPromises.appendFile(logFilePath, line).catch(() => {});
            return;
        }
        const queue = this.getQueue(level);
        queue.push(line);
        if (queue.length >= this.batchSize) {
            this.flushQueue(level);
        } else {
            this.scheduleFlush(level);
        }
    }

    debug(...stuff: any[]) {
        if (!this.canDebug()) return;
        const LEVEL = "DEBUG";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL}][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.magenta(prefix);
            console.log(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
    log(...stuff: any[]) {
        this.info(...stuff);
    }
    info(...stuff: any[]) {
        if (!this.canInfo()) return;
        const LEVEL = "INFO";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL} ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.cyan(prefix);
            console.log(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
    warn(...stuff: any[]) {
        if (!this.canWarn()) return;
        const LEVEL = "WARN";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL} ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.yellow(prefix);
            console.warn(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
    error(...stuff: any[]) {
        if (!this.canError()) return;
        const LEVEL = "ERROR";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL}][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.red(prefix);
            console.error(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
    mempool(...stuff: any[]) {
        if (!this.canMempool()) return;
        const LEVEL = "MEMPOOL";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL} ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.green(prefix);
            console.log(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
    rollback(...stuff: any[]) {
        if (!this.canRollback()) return;
        const LEVEL = "ROLLBACK";

        this.recordRecent(LEVEL, stuff);

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL} ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.magenta(prefix);
            console.log(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }

    child(category: string): any {
        const self = this;
        return {
            debug(...stuff: any[]) {
                self.debug({ category }, ...stuff);
            },
            info(...stuff: any[]) {
                self.info({ category }, ...stuff);
            },
            warn(...stuff: any[]) {
                self.warn({ category }, ...stuff);
            },
            error(...stuff: any[]) {
                self.error({ category }, ...stuff);
            },
            mempool(...stuff: any[]) {
                self.mempool({ category }, ...stuff);
            },
            rollback(...stuff: any[]) {
                self.rollback({ category }, ...stuff);
            },
            child(subCategory: string): any {
                return self.child(`${category}/${subCategory}`);
            },
        };
    }

    public getLogPath(level: LogLevelString): string {
        const network = process.env.NETWORK ?? "preprod";
        const logDir = this.config.logDirectory ||
            `./src/store/logs/${network}/`;
        return path.join(logDir, `${level.toLowerCase()}.jsonl`);
    }
}

export const logger = new Logger({ logLevel: LogLevel.DEBUG });
process.on("beforeExit", async () => await logger.flushAll());
// No SIGINT/SIGTERM handlers here: they used to call process.exit(0) right after the
// flush and cut the node's own shutdown (open range transaction, peers, workers) short.
// The node's start() owns the signals and flushes the logger last.
