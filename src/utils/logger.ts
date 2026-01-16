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
    logDirectory: "./src/logs/preprod/",
    logToFile: true,
    logToConsole: true,
};

export class Logger {
    private config: LoggerConfig = { ...defaultLoggerConfig };
    private _colors: boolean = true;

    constructor(config?: Partial<LoggerConfig>) {
        let initConfig = { ...defaultLoggerConfig };
        if (config) {
            const processed = { ...config };
            if (typeof processed.logLevel === 'string') {
                processed.logLevel = logLevelFromString(processed.logLevel);
            }
            initConfig = { ...initConfig, ...processed };
        }
        this.config = initConfig;
        this.updatePaths();
    }

    private updatePaths() {
        const dir = this.config.logDirectory || "./src/logs/preprod/";
        fs.mkdirSync(dir, { recursive: true });
        const levels = ['debug', 'info', 'warn', 'error', 'mempool'];
        for (const level of levels) {
            const logFilePath = path.join(dir, `${level}.jsonl`);
            if (!fs.existsSync(logFilePath)) {
                fs.writeFileSync(logFilePath, '');
            }
        }
    }

    public setLogConfig(config: Partial<LoggerConfig>) {
        const processedConfig = { ...config };
        if (typeof processedConfig.logLevel === 'string') {
            processedConfig.logLevel = logLevelFromString(processedConfig.logLevel);
        }
        Object.assign(this.config, processedConfig);
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
    canMempool(): boolean {
        return this.canInfo();
    }

    setLogLevel(level: LogLevel) {
        this.config.logLevel = level;
    }

    private appendLog(level: string, stuff: any[]) {
        const logFilePath = path.join(this.config.logDirectory || "./src/logs/preprod/", `${level.toLowerCase()}.jsonl`);
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
    mempool(...stuff: any[]) {
        if (!this.canMempool()) return;
        const LEVEL = "MEMPOOL";

        if (this.config.logToConsole) {
            let prefix = `[${LEVEL} ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.green(prefix);
            console.log(prefix, ...stuff);
        }

        if (this.config.logToFile) {
            this.appendLog(LEVEL, stuff);
        }
    }

    public getLogPath(level: LogLevelString): string {
        return path.join(this.config.logDirectory || "./logs", `${level.toLowerCase()}.jsonl`);
    }
}

export const logger = new Logger({ logLevel: LogLevel.DEBUG });
