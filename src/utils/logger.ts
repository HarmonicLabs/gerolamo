import color from "picocolors";

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
}

const defaultLoggerConfig: LoggerConfig = {
    logLevel: LogLevel.INFO,
};

export class Logger {
    private config: LoggerConfig = { ...defaultLoggerConfig };
    private _colors: boolean = true;

    constructor(config?: Partial<LoggerConfig>) {
        this.config = {
            ...defaultLoggerConfig,
            ...config,
        };
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

    debug(...stuff: any[]) {
        if (!this.canDebug()) return;

        const message = stuff[0];
        if (
            typeof message === "string" &&
            (message.includes("volatile state") ||
                message.includes("stable state") ||
                message.includes("rollback") || message.includes("roll") ||
                message.includes("chain selection") ||
                message.includes("Validated") ||
                message.includes("Fetched block"))
        ) {
            let prefix = `[Debug][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.magenta(prefix);

            console.log(prefix, ...stuff);
        }
    }
    log(...stuff: any[]) {
        this.info(...stuff);
    }
    info(...stuff: any[]) {
        if (!this.canInfo()) return;

        const message = stuff[0];
        if (
            typeof message === "string" &&
            message.includes("Block applied to stable state")
        ) {
            let prefix = `[Info ][${new Date().toUTCString()}]:`;
            if (this._colors) prefix = color.cyan(prefix);

            console.log(prefix, ...stuff);
        }
    }
    warn(..._stuff: any[]) {
        // Disabled
    }
    error(...stuff: any[]) {
        if (!this.canError()) return;

        let prefix = `[Error][${new Date().toUTCString()}]:`;
        if (this._colors) prefix = color.red(prefix);

        console.error(prefix, ...stuff);
    }
}

export const logger = new Logger({ logLevel: LogLevel.DEBUG });
