import color from "picocolors";
import * as fs from "fs";
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
}

const defaultLoggerConfig: LoggerConfig = {
    logLevel: LogLevel.INFO,
    logDirectory: "./logs",
    logToFile: true,
    logToConsole: true,
};

export class Logger {
    private config: LoggerConfig = { ...defaultLoggerConfig };
    private _colors: boolean = true;

    constructor(config?: Partial<LoggerConfig>) {
        this.config = {
            ...defaultLoggerConfig,
            ...config,
        };
        this.updatePaths();
    }

    private updatePaths() {
        const dir = this.config.logDirectory || "./logs";
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {}
    }

    public setLogConfig(config: Partial<LoggerConfig>) {
        Object.assign(this.config, config);
        this.updatePaths();
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

    setLogLevel(level: LogLevel) {
        this.config.logLevel = level;
    }

    private appendLog(level: string, stuff: any[]) {
        const logFilePath = path.join(this.config.logDirectory || "./logs", `${level.toLowerCase()}.jsonl`);
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            args: stuff.map((arg: any) => {
                if (arg instanceof Error) {
                    return {
                        message: arg.message,
                        stack: arg.stack,
                        name: arg.name
                    };
                }
                if (typeof arg === "bigint") {
                    return arg.toString();
                }
                try {
                    return JSON.parse(JSON.stringify(arg));
                } catch {
                    return String(arg);
                }
            })
        };
        try {
            fs.appendFileSync(logFilePath, JSON.stringify(entry) + "\n");
        } catch (logErr) {
            console.error("Failed to write log:", logErr);
        }
    }

    debug(...stuff: any[]) {
        if (!this.canDebug()) return;
        const LEVEL = "DEBUG";

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

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL}][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.red(prefix);
            console.error(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }
}

export const logger = new Logger({ logLevel: LogLevel.DEBUG });
