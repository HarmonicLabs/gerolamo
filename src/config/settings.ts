/**
 * Every runtime setting of the node, in one registry: a CLI flag, a config.json key and a default each.
 * Gerolamo reads no environment variables: a value comes from the command line, else from config.json (the network's
 * bundled config, with the instance file given by --config merged over it), else the default here.
 *
 * - `settings()` returns the resolved values. Until `initSettings()` runs (tests, scripts) it returns the defaults.
 * - Flags are generated from the registry (`registerSettingFlags`), and so is docs/CONFIG.md (`settingsMarkdown`).
 * - Booleans get `--x` and `--no-x`; a flag that is not given leaves the decision to config.json.
 * - Any config.json key, listed here or not, can also be set with `--set <key.path>=<value>` (repeatable).
 * - Secrets never take a plain flag (it would show in `ps`): config.json, or a `--…-file` flag naming a file.
 * - Worker threads do not inherit them: the parent posts `settingsMessage()` first, the worker calls
 *   `receiveSettings()` at the top of its message handler.
 */
import { readFileSync } from "node:fs";

type Kind = "bool" | "int" | "string" | "path" | "enum";

interface Def<T> {
    /** config.json key (dotted for nested objects); null when the setting is command-line only. */
    key: string | null;
    /** Long flag without the leading dashes. */
    flag: string;
    kind: Kind;
    choices?: readonly string[];
    default: T;
    describe: string;
    /** Secret: no plain flag; `--<flag>-file <path>` reads it from a file. */
    secret?: boolean;
    /** The environment variable(s) this replaces (for the migration warning and the docs). */
    was?: string[];
    group: string;
}

const d = <T>(def: Def<T>): Def<T> => def;

export const SETTINGS = {
    // ---- instance
    network: d<string>({ key: "networkName", flag: "network", kind: "enum", choices: ["preview", "preprod", "mainnet"], default: "preprod", describe: "Network; picks the bundled config src/config/<network>/config.json", was: ["NETWORK"], group: "Instance" }),
    config: d<string | null>({ key: null, flag: "config", kind: "path", default: null, describe: "Instance config file merged over the network's bundled config.json", was: ["GEROLAMO_CONFIG_PATH"], group: "Instance" }),
    dbPath: d<string>({ key: "dbPath", flag: "db-path", kind: "path", default: "./.live/test.db", describe: "SQLite database file", was: ["DATABASE_URL", "GEROLAMO_DB_PATH"], group: "Instance" }),
    port: d<number>({ key: "port", flag: "port", kind: "int", default: 3030, describe: "HTTP port (API, /stats, dashboards)", was: ["PORT", "GEROLAMO_PORT"], group: "Instance" }),
    heapDir: d<string>({ key: "heapDir", flag: "heap-dir", kind: "path", default: ".", describe: "Directory for SIGUSR2 heap summaries", was: ["GEROLAMO_HEAP_DIR"], group: "Instance" }),
    failedBlockDir: d<string>({ key: "failedBlockDir", flag: "failed-block-dir", kind: "path", default: "./logs", describe: "Directory where blocks that fail validation are written", was: ["GEROLAMO_FAILED_BLOCK_DIR"], group: "Instance" }),
    blockfrostProjectId: d<string | null>({ key: "blockfrostProjectId", flag: "blockfrost-project-id", kind: "string", secret: true, default: null, describe: "Blockfrost project id for era and epoch fetches", was: ["BLOCKFROST_PROJECT_ID"], group: "Instance" }),

    // ---- servers
    n2c: d<boolean>({ key: "n2c.enabled", flag: "n2c", kind: "bool", default: true, describe: "Serve node-to-client on the N2C socket (when a socket path is set)", was: ["GEROLAMO_N2C"], group: "Servers" }),
    n2cSocket: d<string | null>({ key: "n2cSocketPath", flag: "n2c-socket", kind: "path", default: null, describe: "N2C node.socket path", was: ["GEROLAMO_N2C_SOCKET"], group: "Servers" }),
    n2n: d<boolean | null>({ key: "n2n.enabled", flag: "n2n", kind: "bool", default: null, describe: "Inbound node-to-node listener (default: on for role relay or producer)", was: ["GEROLAMO_N2N"], group: "Servers" }),
    n2nPort: d<number>({ key: "n2n.port", flag: "n2n-port", kind: "int", default: 3001, describe: "N2N listen port", was: ["GEROLAMO_N2N_PORT"], group: "Servers" }),
    n2nHost: d<string>({ key: "n2n.host", flag: "n2n-host", kind: "string", default: "0.0.0.0", describe: "N2N bind address", was: ["GEROLAMO_N2N_HOST"], group: "Servers" }),
    n2nWs: d<boolean>({ key: "n2n.ws.enabled", flag: "n2n-ws", kind: "bool", default: false, describe: "N2N over WebSocket (browser nodes)", group: "Servers" }),
    n2nWsPort: d<number>({ key: "n2n.ws.port", flag: "n2n-ws-port", kind: "int", default: 3002, describe: "N2N-over-WebSocket port", was: ["GEROLAMO_N2N_WS_PORT"], group: "Servers" }),
    n2nWsHost: d<string>({ key: "n2n.ws.host", flag: "n2n-ws-host", kind: "string", default: "0.0.0.0", describe: "N2N-over-WebSocket bind address", was: ["GEROLAMO_N2N_WS_HOST"], group: "Servers" }),
    prometheus: d<string | null>({ key: null, flag: "prometheus", kind: "string", default: null, describe: "Prometheus endpoint: host:port, a port, or off (overrides config prometheus.*)", was: ["GEROLAMO_PROMETHEUS"], group: "Servers" }),
    utxorpc: d<string | null>({ key: null, flag: "utxorpc", kind: "string", default: null, describe: "UTxO RPC: on, off, host:port or a port (overrides config utxorpc.*)", was: ["GEROLAMO_UTXORPC"], group: "Servers" }),
    mithrilArtifacts: d<string | null>({ key: null, flag: "mithril-artifacts", kind: "string", default: null, describe: "Serve a Mithril artifact store from this directory, or off (overrides config mithril.*)", was: ["GEROLAMO_MITHRIL_ARTIFACTS"], group: "Servers" }),
    mithrilProgressFile: d<string | null>({ key: "mithril.progressFile", flag: "mithril-progress-file", kind: "path", default: null, describe: "Mithril bootstrap progress JSON shown in /stats", was: ["GEROLAMO_MITHRIL_PROGRESS"], group: "Servers" }),
    explorerWorker: d<boolean>({ key: "explorer.worker", flag: "explorer-worker", kind: "bool", default: true, describe: "Write the explorer index in a worker (off: inline)", was: ["GEROLAMO_EXPLORER_WORKER"], group: "Servers" }),
    keepAliveTimeoutMs: d<number>({ key: "keepAliveTimeoutMs", flag: "keepalive-timeout-ms", kind: "int", default: 60_000, describe: "Keep-alive reply deadline per peer", was: ["GEROLAMO_KEEPALIVE_TIMEOUT_MS"], group: "Servers" }),

    // ---- storage
    blockStore: d<boolean>({ key: "blockStore", flag: "block-store", kind: "bool", default: true, describe: "Keep blocks in cardano-node chunk files", was: ["GEROLAMO_BLOCK_STORE"], group: "Storage" }),
    blockStoreDir: d<string | null>({ key: "blockStoreDir", flag: "block-store-dir", kind: "path", default: null, describe: "Block store directory (default: <dir of db-path>/db)", was: ["GEROLAMO_BLOCK_STORE_DIR"], group: "Storage" }),
    blockStoreMode: d<string>({ key: "blockStoreMode", flag: "block-store-mode", kind: "enum", choices: ["mirror", "primary"], default: "primary", describe: "Block store role", was: ["GEROLAMO_BLOCK_STORE_MODE"], group: "Storage" }),
    relayStore: d<string>({ key: "relayStore", flag: "relay-store", kind: "enum", choices: ["sqlite", "chunks"], default: "sqlite", describe: "Store the N2N servers read blocks from", was: ["GEROLAMO_RELAY_STORE"], group: "Storage" }),
    blockFsync: d<string>({ key: "blockFsync", flag: "block-fsync", kind: "enum", choices: ["batch", "block", "none"], default: "batch", describe: "fsync policy for block files", was: ["GEROLAMO_BLOCK_FSYNC"], group: "Storage" }),
    ledgerStore: d<string>({ key: "ledgerStore", flag: "ledger-store", kind: "enum", choices: ["sqlite", "dual", "lmdb"], default: "sqlite", describe: "Ledger state backend", was: ["GEROLAMO_LEDGER_STORE"], group: "Storage" }),
    ledgerDir: d<string | null>({ key: "ledgerDir", flag: "ledger-dir", kind: "path", default: null, describe: "LMDB ledger directory (default: <dir of db-path>/ledger)", was: ["GEROLAMO_LEDGER_DIR"], group: "Storage" }),
    ledgerSqlWrites: d<boolean>({ key: "ledgerSqlWrites", flag: "ledger-sql-writes", kind: "bool", default: true, describe: "Also write ledger state to SQLite in lmdb mode", was: ["GEROLAMO_LEDGER_SQL_WRITES"], group: "Storage" }),
    ledgerKeepEpochs: d<number>({ key: "ledgerKeepEpochs", flag: "ledger-keep-epochs", kind: "int", default: 30, describe: "Epochs of report history kept (at least 4)", was: ["GEROLAMO_LEDGER_KEEP_EPOCHS"], group: "Storage" }),
    ledgerDiffFsync: d<string>({ key: "ledgerDiffFsync", flag: "ledger-diff-fsync", kind: "enum", choices: ["batch", "block", "none"], default: "batch", describe: "fsync policy for ledger diffs", was: ["GEROLAMO_LEDGER_DIFF_FSYNC"], group: "Storage" }),
    genesisExact: d<boolean>({ key: "genesisExact", flag: "genesis-exact", kind: "bool", default: false, describe: "The store was synced from genesis: treat its ledger as exact", was: ["GEROLAMO_GENESIS_EXACT"], group: "Storage" }),
    utxoIndex: d<boolean>({ key: "utxoIndex", flag: "utxo-index", kind: "bool", default: true, describe: "Maintain the LMDB UTxO indexes", was: ["GEROLAMO_UTXO_INDEX"], group: "Storage" }),
    lmdbLib: d<string | null>({ key: "lmdbLib", flag: "lmdb-lib", kind: "path", default: null, describe: "Path to liblmdb (default: search the standard library paths)", was: ["LMDB_LIB"], group: "Storage" }),
    syncSql: d<boolean>({ key: "syncSql", flag: "sync-sql", kind: "bool", default: true, describe: "Use the synchronous bun:sqlite writer (off: Bun.SQL)", was: ["GEROLAMO_SYNC_SQL"], group: "Storage" }),
    applySkipDeltas: d<boolean>({ key: "applySkipDeltas", flag: "apply-skip-deltas", kind: "bool", default: false, describe: "Skip utxo_deltas rows while applying blocks", was: ["APPLY_SKIP_DELTAS"], group: "Storage" }),
    applySkipIndex: d<boolean>({ key: "applySkipIndex", flag: "apply-skip-index", kind: "bool", default: false, describe: "Skip the tx, address and explorer indexes while applying blocks", was: ["APPLY_SKIP_INDEX"], group: "Storage" }),

    // ---- consensus
    experimentalHardForks: d<boolean | null>({ key: "experimentalHardForksEnabled", flag: "experimental-hard-forks", kind: "bool", default: null, describe: "Make the Dijkstra era reachable", was: ["GEROLAMO_EXPERIMENTAL_HARD_FORKS"], group: "Consensus" }),
    chainSelection: d<string>({ key: "consensus.chainSelection", flag: "chain-selection", kind: "enum", choices: ["legacy", "shadow", "praos"], default: "legacy", describe: "Chain selection", was: ["GEROLAMO_CHAIN_SELECTION"], group: "Consensus" }),
    consensusMode: d<string>({ key: "consensus.mode", flag: "consensus-mode", kind: "enum", choices: ["praos", "genesis"], default: "praos", describe: "Consensus mode", was: ["GEROLAMO_CONSENSUS_MODE"], group: "Consensus" }),
    csj: d<boolean>({ key: "consensus.csj", flag: "csj", kind: "bool", default: true, describe: "ChainSync Jumping in genesis mode", was: ["GEROLAMO_CSJ"], group: "Consensus" }),
    deferVrf: d<boolean>({ key: "consensus.deferVrf", flag: "defer-vrf", kind: "bool", default: true, describe: "Defer VRF checks of epoch-boundary headers (off: hold them)", was: ["GEROLAMO_DEFER_VRF"], group: "Consensus" }),
    rulesAhead: d<boolean>({ key: "consensus.rulesAhead", flag: "rules-ahead", kind: "bool", default: true, describe: "Run ledger rules ahead in workers", was: ["GEROLAMO_RULES_AHEAD"], group: "Consensus" }),
    govRules: d<string>({ key: "consensus.govRules", flag: "gov-rules", kind: "enum", choices: ["strict", "report"], default: "strict", describe: "Governance rules: reject, or only report, violations", was: ["GEROLAMO_GOV_RULES"], group: "Consensus" }),

    // ---- plutus
    plutusPhase2: d<string>({ key: "plutus.phase2", flag: "plutus-phase2", kind: "enum", choices: ["enforce", "report", "off"], default: "enforce", describe: "Plutus phase-2 validation", was: ["GEROLAMO_PLUTUS_PHASE2"], group: "Plutus" }),
    plutusShadowMs: d<number>({ key: "plutus.shadowMs", flag: "plutus-shadow-ms", kind: "int", default: 2000, describe: "Wall-clock cap per redeemer (at least 50)", was: ["GEROLAMO_PLUTUS_SHADOW_MS"], group: "Plutus" }),
    plutusShadowSample: d<number>({ key: "plutus.shadowSample", flag: "plutus-shadow-sample", kind: "int", default: 1, describe: "Evaluate every n-th Plutus transaction", was: ["GEROLAMO_PLUTUS_SHADOW_SAMPLE"], group: "Plutus" }),
    plutusShadowMaxCpu: d<string>({ key: "plutus.shadowMaxCpu", flag: "plutus-shadow-max-cpu", kind: "string", default: "3000000000", describe: "Skip a redeemer declaring more CPU than this", was: ["GEROLAMO_PLUTUS_SHADOW_MAX_CPU"], group: "Plutus" }),
    plutusShadowStepCpu: d<string>({ key: "plutus.shadowStepCpu", flag: "plutus-shadow-step-cpu", kind: "string", default: "20000000", describe: "Refuse a single builtin step costing more CPU than this", was: ["GEROLAMO_PLUTUS_SHADOW_STEP_CPU"], group: "Plutus" }),
    plutusLegacyShadow: d<boolean>({ key: "plutus.legacyShadow", flag: "plutus-legacy-shadow", kind: "bool", default: false, describe: "Use the legacy shadow evaluator", was: ["GEROLAMO_PLUTUS_LEGACY_SHADOW"], group: "Plutus" }),
    plutusDumpDir: d<string | null>({ key: "plutus.dumpDir", flag: "plutus-dump-dir", kind: "path", default: null, describe: "Write applied Plutus programs here as hex", was: ["GEROLAMO_PLUTUS_DUMP_DIR"], group: "Plutus" }),

    // ---- local state query
    lsqNonmyopicSeed: d<string | null>({ key: "lsq.nonmyopicSeed", flag: "lsq-nonmyopic-seed", kind: "path", default: null, describe: "cardano-node ledger-state file that seeds the non-myopic rewards state", was: ["GEROLAMO_LSQ_NONMYOPIC_SEED"], group: "Local state query" }),
    lsqGovCache: d<string | null>({ key: "lsq.govCache", flag: "lsq-gov-cache", kind: "path", default: null, describe: "Governance index cache file (\"\" = memory only; default <ledger-dir>/../lsq-gov-index.json)", was: ["GEROLAMO_LSQ_GOV_CACHE"], group: "Local state query" }),
    lsqPulserBackfill: d<boolean>({ key: "lsq.pulserBackfill", flag: "lsq-pulser-backfill", kind: "bool", default: false, describe: "Backfill a missing pulser snapshot", was: ["GEROLAMO_LSQ_PULSER_BACKFILL"], group: "Local state query" }),
    shelleyGenesisFile: d<string | null>({ key: "shelleyGenesisFile", flag: "shelley-genesis-file", kind: "path", default: null, describe: "Shelley genesis file (default: the bundled one)", was: ["GEROLAMO_SHELLEY_GENESIS"], group: "Local state query" }),
    conwayGenesisFile: d<string | null>({ key: "conwayGenesisFile", flag: "conway-genesis-file", kind: "path", default: null, describe: "Conway genesis file (default: the bundled one)", was: ["GEROLAMO_CONWAY_GENESIS"], group: "Local state query" }),

    // ---- traces (debugging)
    traceHeaders: d<boolean>({ key: "trace.headers", flag: "trace-headers", kind: "bool", default: false, describe: "Log every header that passes validation", was: ["GEROLAMO_HEADER_TRACE"], group: "Traces" }),
    traceTxSubmission: d<boolean>({ key: "trace.txSubmission", flag: "trace-tx-submission", kind: "bool", default: false, describe: "Trace tx-submission messages", was: ["GEROLAMO_TXSUB_TRACE"], group: "Traces" }),
    traceN2nChainSync: d<boolean>({ key: "trace.n2nChainSync", flag: "trace-n2n-chain-sync", kind: "bool", default: true, describe: "Trace the first chain-sync messages of each inbound N2N peer", was: ["GEROLAMO_N2N_TRACE"], group: "Traces" }),
    traceSql: d<boolean>({ key: "trace.sql", flag: "trace-sql", kind: "bool", default: false, describe: "Log the time of every SQL statement", was: ["GEROLAMO_SQL_PROFILE"], group: "Traces" }),
    tracePlutus: d<number>({ key: "trace.plutus", flag: "trace-plutus", kind: "int", default: 0, describe: "Plutus builtin cost trace: 0 off, 1 summary, 2 every step", was: ["GEROLAMO_PLUTUS_TRACE"], group: "Traces" }),
    tracePlutusBuiltins: d<boolean>({ key: "trace.plutusBuiltins", flag: "trace-plutus-builtins", kind: "bool", default: false, describe: "One log line per Plutus builtin call", was: ["GEROLAMO_PLUTUS_BUILTIN_TRACE"], group: "Traces" }),
    tracePlutusBuiltinsFull: d<boolean>({ key: "trace.plutusBuiltinsFull", flag: "trace-plutus-builtins-full", kind: "bool", default: false, describe: "Do not truncate bytes in the builtin trace", was: ["GEROLAMO_PLUTUS_BUILTIN_TRACE_FULL"], group: "Traces" }),
} as const;

export type SettingId = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingId]: (typeof SETTINGS)[K]["default"] };

const defaults = (): Settings => Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.default])) as Settings;

let current: Settings = defaults();
/** Where each value came from: "flag", "config" or "default" (for the startup log and /stats). */
let sources: Record<SettingId, "flag" | "config" | "default"> = Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, "default"])) as any;

/** The resolved settings (the defaults until initSettings runs). */
export function settings(): Readonly<Settings> { return current; }
export function settingSources(): Readonly<typeof sources> { return sources; }

/** Replace the settings (startup, and tests). Missing ids keep their defaults. */
export function initSettings(values: Partial<Settings>, from?: Partial<typeof sources>): Readonly<Settings> {
    current = { ...defaults(), ...values };
    sources = { ...sources, ...(from ?? {}) } as typeof sources;
    return current;
}
/** For tests: change some settings and return a function that restores the previous ones. */
export function withSettings(values: Partial<Settings>): () => void {
    const before = current;
    current = { ...current, ...values };
    return () => { current = before; };
}

const camel = (flag: string) => flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function getPath(obj: unknown, path: string): unknown {
    let o: any = obj;
    for (const p of path.split(".")) { if (o == null || typeof o !== "object") return undefined; o = o[p]; }
    return o;
}
export function setPath(obj: Record<string, any>, path: string, value: unknown): void {
    const parts = path.split(".");
    let o = obj;
    for (const p of parts.slice(0, -1)) { if (o[p] == null || typeof o[p] !== "object") o[p] = {}; o = o[p]; }
    o[parts[parts.length - 1]!] = value;
}

function coerce(id: SettingId, raw: unknown, where: string): unknown {
    const def = SETTINGS[id] as Def<unknown>;
    if (raw === null) return null;
    switch (def.kind) {
        case "bool": {
            if (typeof raw === "boolean") return raw;
            const s = String(raw).toLowerCase();
            if (["1", "true", "on", "yes"].includes(s)) return true;
            if (["0", "false", "off", "no"].includes(s)) return false;
            throw new Error(`${where}: ${def.flag} must be true or false, got ${JSON.stringify(raw)}`);
        }
        case "int": {
            const n = typeof raw === "number" ? raw : Number(String(raw).trim());
            if (!Number.isInteger(n)) throw new Error(`${where}: ${def.flag} must be an integer, got ${JSON.stringify(raw)}`);
            return n;
        }
        case "enum": {
            const s = String(raw).toLowerCase();
            const norm = def.flag.endsWith("fsync") && ["0", "off"].includes(s) ? "none" : s;
            if (!def.choices!.includes(norm)) throw new Error(`${where}: ${def.flag} must be one of ${def.choices!.join(", ")}, got ${JSON.stringify(raw)}`);
            return norm;
        }
        default:
            return String(raw);
    }
}

/** Parse the values of repeatable `--set key.path=value` flags (the value is JSON when it parses, else a string). */
export function parseSetFlags(pairs: string[] | undefined): Array<[string, unknown]> {
    return (pairs ?? []).map((p) => {
        const i = p.indexOf("=");
        if (i <= 0) throw new Error(`--set ${p}: expected key.path=value`);
        const v = p.slice(i + 1);
        let value: unknown = v;
        try { value = JSON.parse(v); } catch { /* a plain string */ }
        return [p.slice(0, i), value];
    });
}

/**
 * Resolve every setting: the command-line flag (commander's parsed options), else the config.json value, else the
 * default. `--set` pairs are applied to the config first, as command-line values for any config key.
 */
export function resolveSettings(flags: Record<string, unknown>, config: Record<string, unknown>): { settings: Settings; sources: typeof sources; config: Record<string, unknown> } {
    for (const [path, value] of parseSetFlags(flags.set as string[] | undefined)) setPath(config, path, value);
    const out = defaults() as Record<string, unknown>;
    const src = {} as Record<string, "flag" | "config" | "default">;
    for (const [id, def] of Object.entries(SETTINGS) as Array<[SettingId, Def<unknown>]>) {
        const name = camel(def.flag);
        let flagValue = def.secret ? undefined : flags[name];
        if (def.secret && typeof flags[`${name}File`] === "string") flagValue = readFileSync(flags[`${name}File`] as string, "utf8").trim();
        if (flagValue !== undefined) { out[id] = coerce(id, flagValue, "command line"); src[id] = "flag"; continue; }
        const cfg = def.key ? getPath(config, def.key) : undefined;
        if (cfg !== undefined && cfg !== "") { out[id] = coerce(id, cfg, `config.json ${def.key}`); src[id] = "config"; continue; }
        src[id] = "default";
    }
    return { settings: out as Settings, sources: src as typeof sources, config };
}

/** Add every setting's flag to a commander command, plus --set. */
export function registerSettingFlags(cmd: { option: (flags: string, description?: string, ...rest: any[]) => any }): void {
    for (const def of Object.values(SETTINGS) as Array<Def<unknown>>) {
        const dflt = def.default === null ? "" : ` (default ${JSON.stringify(def.default)})`;
        const cfg = def.key ? `; config ${def.key}` : "";
        if (def.secret) { cmd.option(`--${def.flag}-file <path>`, `${def.describe}: read from this file${cfg}`); continue; }
        if (def.kind === "bool") {
            cmd.option(`--${def.flag}`, `${def.describe}${dflt}${cfg}`);
            cmd.option(`--no-${def.flag}`, `Turn off: ${def.describe.charAt(0).toLowerCase()}${def.describe.slice(1)}`);
            continue;
        }
        const choices = def.choices ? ` [${def.choices.join("|")}]` : "";
        cmd.option(`--${def.flag} <value>`, `${def.describe}${choices}${dflt}${cfg}`);
    }
    cmd.option("--set <key=value>", "Set any config.json key, e.g. --set peerGovernor.targetHot=8 (repeatable)", (v: string, prev: string[] = []) => [...prev, v]);
}

/** Old environment variables that are still set: they are ignored now; the replacement flag for each. */
export function ignoredEnvironment(env: Record<string, string | undefined>): Array<{ name: string; flag: string }> {
    const out: Array<{ name: string; flag: string }> = [];
    for (const def of Object.values(SETTINGS) as Array<Def<unknown>>) {
        for (const name of def.was ?? []) if (env[name] !== undefined) out.push({ name, flag: def.secret ? `--${def.flag}-file` : `--${def.flag}` });
    }
    return out;
}

// ---- workers

const MSG = "__gerolamoSettings";
/** The message a parent posts to a new worker first. */
export function settingsMessage(): Record<string, unknown> { return { [MSG]: current }; }
/** At the top of a worker's message handler: true when the message carried the settings (then ignore it). */
export function receiveSettings(data: unknown): boolean {
    if (!data || typeof data !== "object" || !(MSG in (data as object))) return false;
    current = { ...defaults(), ...((data as Record<string, unknown>)[MSG] as Partial<Settings>) };
    return true;
}

// ---- docs

/** docs/CONFIG.md: every setting with its flag, config key, default and the variable it replaced. */
export function settingsMarkdown(): string {
    const groups = new Map<string, Array<[SettingId, Def<unknown>]>>();
    for (const [id, def] of Object.entries(SETTINGS) as Array<[SettingId, Def<unknown>]>) {
        if (!groups.has(def.group)) groups.set(def.group, []);
        groups.get(def.group)!.push([id, def]);
    }
    const lines = [
        "# Gerolamo settings",
        "",
        "Generated from `src/config/settings.ts` (`bun src/index.ts settings-doc`). Gerolamo reads no environment variables.",
        "Each setting is a command-line flag and a config.json key; the flag wins, then config.json (the network's bundled",
        "file with `--config` merged over it), then the default. Any other config.json key can be set from the command line",
        "with `--set key.path=value`. Secrets have no plain flag: put them in config.json or pass `--…-file <path>`.",
        "",
    ];
    for (const [group, rows] of groups) {
        lines.push(`## ${group}`, "", "| Flag | config.json | Default | Meaning | Replaces |", "|---|---|---|---|---|");
        for (const [, def] of rows) {
            const flag = def.secret ? `\`--${def.flag}-file <path>\`` : def.kind === "bool" ? `\`--${def.flag}\` / \`--no-${def.flag}\`` : `\`--${def.flag} <${def.choices ? def.choices.join("\\|") : def.kind}>\``;
            lines.push(`| ${flag} | ${def.key ? `\`${def.key}\`` : "-"} | ${def.default === null ? "-" : `\`${JSON.stringify(def.default)}\``} | ${def.describe} | ${(def.was ?? []).map((w) => `\`${w}\``).join(", ") || "-"} |`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
