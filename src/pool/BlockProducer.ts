/**
 * The block producer (block plan §1–§5, §7 basics): loads the operator's keys,
 * checks the operational certificate against the chain, computes this pool's
 * leader schedule per epoch (in a worker), ticks the wall clock, and when a
 * slot is ours forges a block from the mempool, applies it through the node's
 * own strict validation (`adoptLocalBlock`) and leaves it in the DB, where the
 * inbound relay (ChainSync/BlockFetch hosts) serves it to our relays.
 *
 * Safety: a block that fails our own rules is never published (the forge falls
 * back to an empty body once, then gives the slot up); one block per slot is
 * enforced across restarts through `stateFile`; the KES key only evolves
 * forward; nothing about keys is logged.
 */
import { settingsMessage } from "../config/settings";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { ledgerUtxoReads } from "../ledger/nodeLedgerStore";
import { blockAtSlot, getChainTipFromHeader } from "../db";
import { sql } from "../sql";
import { Tx } from "@harmoniclabs/cardano-ledger-ts";
import { poolStakeForEpoch, opcertCounterState } from "../db/leaderState";
import { readEpochParamsRaw } from "../consensus/epochParams";
import { epochForSlot, epochLengthSlots, firstSlotOfEpoch, type EpochNetwork } from "../utils/epochFromSlotCalculations";
import { logger } from "../utils/logger";
import { assembleBody, splitTx, type TxParts } from "./bodyAssembly";
import { EMPTY_BODY, forgeBlock, type BodySegments } from "./forge";
import {
    checkOperationalCert, evolveKesTo, kesEvolution, kesKeyFromAgent, kesPeriodOfSlot, kesProbe, loadColdVerificationKey, loadKesSigningKey, loadVrfSigningKey, poolIdOf, readOperationalCert, vrfKeyHashOf, zeroise,
    type KesKey, type OperationalCert, type VrfKey,
} from "./keystore";
import { KesAgentClient, type KesAgentClientState } from "./kesAgent/client";
import { kesSourceOf, type KesSource } from "./kesSource";
export { kesSourceOf, type KesSource } from "./kesSource";
import { RecvResult, type AgentBundle } from "./kesAgent/protocol";
import { noteForgeEvent } from "../network/nodeMetrics";
import type { LeaderSlot } from "./leaderSchedule";
import { decideForge, SlotTicker, slotAt, slotStartMs } from "./slotClock";
import { noteForgedBlock } from "./forgedBlocks";

export interface ProducerKeysConfig {
    coldVkeyFile: string;
    /** KES signing key file (cardano-cli `kes.skey`). Exactly one of this and `kesAgentSocket`. */
    kesSkeyFile?: string;
    vrfSkeyFile: string;
    /** Operational certificate file; required with `kesSkeyFile`. With `kesAgentSocket` it is ignored: the agent sends the certificate. */
    opcertFile?: string;
    /**
     * Service socket of a kes-agent (input-output-hk/kes-agent, as cardano-node's
     * `--shelley-kes-agent-socket`): the KES key and the operational certificate come from the
     * agent and are replaced whenever it pushes a new pair. Instead of `kesSkeyFile` + `opcertFile`.
     */
    kesAgentSocket?: string;
    stateFile?: string;
    dryRun?: boolean;
    greeting?: { paymentSkeyFile: string; paymentAddress: string };
    /**
     * Protocol version written into forged headers. cardano-node writes its own supported
     * version (11.0 on preview, 2026-09-13), the ledger checks only that the major is not above
     * a validating node's maximum, and explorers badge blocks by it — Cardanoscan asked for a
     * distinctive minor (11.67) to mark blocks minted by Gerolamo. Unset: the epoch's ledger
     * protocol version.
     */
    headerProtocolVersion?: { major: number; minor: number };
}

export interface ShelleyGenesisLike {
    activeSlotsCoeff: number;
    slotsPerKESPeriod: number;
    maxKESEvolutions: number;
}

/** What the producer needs from the node; the real one is the orchestrator + DB, tests pass fakes. */
export interface ProducerNode {
    network: EpochNetwork;
    era: number; // 6 Babbage, 7 Conway (the era the tip is in)
    genesis: ShelleyGenesisLike;
    nonceFor(epoch: number): Promise<string | null>;
    sigmaFor(epoch: number, poolId: string): Promise<{ num: bigint; den: bigint } | null>;
    tip(): Promise<{ slot: bigint; blockNumber: bigint; hashHex: string } | null>;
    protocolVersion(epoch: number): Promise<{ major: number; minor: number }>;
    maxBlockBodySize(epoch: number): Promise<number>;
    lastOnChainOpcertCounter(poolId: string): Promise<bigint | null>;
    mempoolTxs(): Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>>;
    /**
     * The validating mempool's snapshot for a block at `slot`: every transaction re-applied at
     * that slot in mempool order, cut to the block's capacity. When present it replaces
     * `mempoolTxs` + `txSanity` (and the periodic sweep: the mempool prunes itself on each tip).
     */
    mempoolSnapshot?(slot: bigint): Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>>;
    dropFromMempool(hashes: Uint8Array[]): Promise<void>;
    adopt(blockFetchBytes: Uint8Array): Promise<void>;
    /**
     * The one-off greeting transaction ("Gerolamo was here!") for the first block this pool
     * forges on the network, built at forge time from the greeting wallet; null when the
     * wallet is not configured or holds nothing usable.
     */
    greetingTx?(): Promise<{ hash: Uint8Array; bytes: Uint8Array } | null>;
    /** Leader schedule for an epoch (worker in production, in-process in tests). */
    schedule(input: { epoch: number; nonceHex: string; sigma: { num: bigint; den: bigint }; vrf: VrfKey }): Promise<LeaderSlot[]>;
    /** The block our chain holds at a slot (index lookup), for confirmed / ghosted / stolen outcomes. */
    blockAtSlot?(slot: bigint): Promise<{ hash: string; blockNo: number } | null>;
    /**
     * Hashes of the given mempool transactions that cannot go into a block at `slot`: expired
     * or not yet valid, or spending outputs the UTxO set no longer holds. Cheap index lookups;
     * the full rules still run on the assembled block.
     */
    txSanity?(txs: Array<{ hash: Uint8Array; bytes: Uint8Array }>, slot: bigint): Promise<Uint8Array[]>;
    /** Peers that would carry a block we forge now: inbound clients chain-syncing at our tip and duplex pullers. */
    carriers?(): { inbound: string[]; duplex: string[]; publicReachable: boolean | null };
    now?: () => number;
}

/**
 * What became of a leader slot, in gLiveView's vocabulary: `upcoming` (not yet), `adopted`
 * (forged and applied to our own chain), `confirmed` (adopted and still on our chain
 * CONFIRM_DEPTH blocks deep), `invalid` (our own rules rejected what we forged), `missed`
 * (the slot passed without a forge: not synced, late tick, already forged), `ghosted`
 * (adopted, then rolled away with nothing at that slot), `stolen` (adopted, then replaced by
 * another pool's block at the same slot: the slot battle was lost).
 */
export type LeaderSlotOutcome = "upcoming" | "adopted" | "confirmed" | "invalid" | "missed" | "ghosted" | "stolen";
export interface LeaderSlotReport { slot: string; time: string; epoch: number; outcome: LeaderSlotOutcome; hash: string | null; note: string | null }
export interface ProducerEpochStats {
    epoch: number;
    /** Leader slots scheduled in the epoch (gLiveView "Leader"). */
    leader: number;
    /** Expected slots for our stake: σ · f · epoch length (gLiveView "Ideal"); null before σ is known. */
    ideal: number | null;
    /** leader / ideal in percent (gLiveView "Luck"). */
    luck: number | null;
    adopted: number; confirmed: number; invalid: number; missed: number; ghosted: number; stolen: number;
}
/** Depth (blocks) after which a confirmed block is final for the tracker: the security parameter k of the supported networks' largest value (mainnet 2160; preview/preprod 432 finalise earlier in practice). */
const FINAL_DEPTH = 2160;
/**
 * KES certificate health, same thresholds as @harmoniclabs/kes `kesStatus`: rotate-soon below 14
 * periods left (~3 weeks at 36-hour periods), rotate-now below 4 (~6 days).
 */
export type KesHealth = "ok" | "rotate-soon" | "rotate-now" | "expired" | "not-yet-valid";
export function kesHealthOf(evolution: number, maxEvolutions: number): KesHealth {
    if (evolution < 0) return "not-yet-valid";
    const left = maxEvolutions - evolution;
    return left <= 0 ? "expired" : left < 4 ? "rotate-now" : left < 14 ? "rotate-soon" : "ok";
}

export type CredentialReload =
    | { ok: true; counter: bigint; kesPeriod: bigint; evolution: number }
    | { ok: false; reason: string; kind?: "invalid-opcert" | "outdated" | "other" };

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Blocks on top of ours before an adopted block counts as confirmed. */
export const CONFIRM_DEPTH = 10;

export interface ProducerStats {
    poolId: string;
    vrfKeyHash: string;
    /**
     * counter and start period from the installed certificate; `chainCounter` is the last counter the chain has
     * seen for this pool (null = none yet). Null while no credentials are installed (kes-agent mode before the
     * agent's first key, or after it dropped the key).
     */
    opcert: { counter: string; kesPeriod: string; chainCounter: string | null } | null;
    kesEvolution: number | null;
    /** KES key life: current period, evolutions used, evolutions left, and when the certificate expires (null without credentials). */
    kes: { period: string; evolution: number; remaining: number; maxEvolutions: number; expiresAt: string; expiresSlot: string; health: KesHealth; counter: "ok" | "behind-chain" | "ahead-of-chain" | "unknown" } | null;
    /** Where the KES key + opcert come from, whether a pair is installed, when it last changed, and the kes-agent connection. */
    credentials: { source: KesSource; installed: boolean; lastUpdate: string | null; agent: KesAgentClientState | null };
    /** Highest slot a header was ever signed for (persisted before signing): no slot at or below it is forged again. */
    signedSlot: string | null;
    /** Slots the wall-clock ticker never evaluated (late by more than a slot); gLiveView "Missed slot leader checks". */
    missedLeaderChecks: number;
    /** A schedule pass (VRF over an epoch) is running right now. */
    scheduling: boolean;
    /** Who would carry a block forged now (propagation readiness); null when the node cannot tell. */
    carriers: { inbound: string[]; duplex: string[]; publicReachable: boolean | null } | null;
    scheduledEpochs: number[];
    leaderSlotsKnown: number;
    nextLeaderSlot: string | null;
    /** Every leader slot of the scheduled epochs with its outcome, ascending by slot. */
    leaderSlots: LeaderSlotReport[];
    /** gLiveView-style counters for the clock epoch. */
    epochStats: ProducerEpochStats;
    forged: number;
    lastForgedSlot: string | null;
    lastError: string | null;
    dryRun: boolean;
}

export class BlockProducer {
    readonly poolId: string;
    private readonly coldVkey: Uint8Array;
    private readonly vrf: VrfKey;
    /**
     * Hot credentials: replaced as a pair by reloadCredentials() (SIGHUP) or a kes-agent push, never
     * mid-forge. Null in kes-agent mode until the agent's first key (and after it drops the key).
     */
    private kes: KesKey | null;
    private opcert: OperationalCert | null;
    readonly kesSource: KesSource;
    private agent: KesAgentClient | null = null;
    private credentialsAt: string | null = null;
    private reloading: Promise<CredentialReload> | null = null;
    /** Serialises credential swaps (SIGHUP and agent pushes). */
    private installQueue: Promise<unknown> = Promise.resolve();
    private readonly leaderSlots = new Map<string, LeaderSlot>(); // slot → entry
    private readonly scheduled = new Set<number>();
    /** The nonce each epoch's schedule was computed from: a schedule built from the evolver's peek before the epoch's last block is provisional. */
    private readonly scheduledNonce = new Map<number, string>();
    /** Computed schedules by epoch, persisted in the state file with the nonce and σ they came from. */
    private readonly cachedSchedules = new Map<number, { nonce: string; sigma: string; slots: LeaderSlot[] }>();
    private scheduling: Promise<void> | null = null;
    /** σ per scheduled epoch (for the ideal / luck figures). */
    private readonly sigmaByEpoch = new Map<number, { num: bigint; den: bigint }>();
    /** What became of each leader slot, by slot; `upcoming` slots have no entry. */
    private readonly outcomes = new Map<string, { outcome: LeaderSlotOutcome; hash: string | null; note: string | null; blockNo?: number }>();
    /** Last on-chain opcert counter for this pool, refreshed with the outcomes. */
    private chainCounter: bigint | null = null;
    private ticker: SlotTicker | null = null;
    /** Resolves when the first schedule pass (started by `start()`) has finished. */
    ready: Promise<void> = Promise.resolve();
    private lastForgedSlot: bigint | null = null;
    /**
     * Highest slot a header was signed for, written to the state file BEFORE the first signature
     * of a slot: a crash between publishing a block and recording it cannot lead to a second,
     * different block for that slot after a restart.
     */
    private signedSlot: bigint | null = null;
    /** Set once the greeting transaction has been in an adopted block on this network. */
    private greeted = false;
    /** Hash of the block that carried the greeting (cleared when that block leaves the chain). */
    private greetingBlock: string | null = null;
    private forged = 0;
    private lastError: string | null = null;
    private forging = false;

    constructor(private readonly cfg: ProducerKeysConfig, private readonly node: ProducerNode) {
        this.kesSource = kesSourceOf(cfg);
        this.coldVkey = loadColdVerificationKey(cfg.coldVkeyFile);
        this.poolId = poolIdOf(this.coldVkey);
        this.vrf = loadVrfSigningKey(cfg.vrfSkeyFile);
        if (this.kesSource === "file") {
            this.kes = loadKesSigningKey(cfg.kesSkeyFile!);
            this.opcert = readOperationalCert(cfg.opcertFile!);
            if (Buffer.from(this.opcert.coldVkey).toString("hex") !== Buffer.from(this.coldVkey).toString("hex")) {
                throw new Error("operational certificate was issued by a different cold key");
            }
            this.credentialsAt = new Date((this.node.now ?? Date.now)()).toISOString();
        } else {
            this.kes = null;
            this.opcert = null;
        }
        this.lastForgedSlot = this.readState();
    }

    /** Verify the certificate against the current slot and the chain, then schedule and start ticking. */
    async start(): Promise<void> {
        const now = (this.node.now ?? Date.now)();
        const slot = slotAt(now, this.node.network);
        if (this.kes && this.opcert) {
            const check = checkOperationalCert(this.opcert, {
                currentKesPeriod: kesPeriodOfSlot(slot, BigInt(this.node.genesis.slotsPerKESPeriod)),
                maxKesEvolutions: BigInt(this.node.genesis.maxKESEvolutions),
                lastOnChainCounter: (this.chainCounter = await this.node.lastOnChainOpcertCounter(this.poolId)),
                kesVkey: this.kes.vkey,
            });
            if (!check.ok) throw new Error(`operational certificate rejected: ${check.reason}`);
            logger.info(`Block producer: pool ${this.poolId}, VRF ${vrfKeyHashOf(this.vrf.vkey).slice(0, 16)}…, opcert counter ${this.opcert.cert.counter} period ${this.opcert.cert.kesPeriod}, KES evolution ${check.evolution}${this.cfg.dryRun ? " (dry run: no forging)" : ""}`);
        } else {
            this.chainCounter = await this.node.lastOnChainOpcertCounter(this.poolId).catch(() => null);
            logger.info(`Block producer: pool ${this.poolId}, VRF ${vrfKeyHashOf(this.vrf.vkey).slice(0, 16)}…, KES key + operational certificate from the kes-agent at ${this.cfg.kesAgentSocket}; no forging until the agent sends them${this.cfg.dryRun ? " (dry run: no forging)" : ""}`);
            this.startAgent();
        }
        // The schedule (a VRF pass over the epoch, minutes under load) fills in behind the
        // ticker: startup must not hold the rest of the node (2026-09-12 09:40 UTC: the inbound
        // listener waited more than five minutes for it after a reboot).
        this.ready = this.ensureSchedules(slot);
        this.ticker = new SlotTicker({ network: this.node.network, now: this.node.now }, (s, nowMs) => { void this.onSlot(s, nowMs); });
        this.ticker.start();
    }

    stop(): void {
        this.ticker?.stop();
        this.ticker = null;
        this.agent?.stop();
        this.agent = null;
    }

    /** kes-agent mode: connect to the agent and install every key it pushes (reconnects forever). */
    private startAgent(): void {
        if (this.agent || this.kesSource !== "kes-agent") return;
        this.agent = new KesAgentClient({
            socketPath: this.cfg.kesAgentSocket!,
            onKey: (bundle) => this.installFromAgent(bundle),
            onDrop: () => this.dropCredentials("the kes-agent dropped the key"),
        });
        this.agent.start();
    }

    /**
     * Install a key bundle pushed by the kes-agent, through the same checks as a SIGHUP reload
     * (cold key, cold signature, KES key match, period window, on-chain counter), plus: the key
     * must sign for the certificate's KES key at its evolution (a self-sign probe, as Dingo), and
     * a certificate older than the installed one is refused. Answers with a RecvResult code.
     */
    async installFromAgent(bundle: AgentBundle): Promise<number> {
        let kes: KesKey;
        try { kes = kesKeyFromAgent(bundle.kesSignKey); }
        catch (err) {
            this.lastError = `credential reload rejected: kes-agent key unusable: ${(err as Error)?.message ?? err}`;
            logger.error(`Block producer: ${this.lastError}`);
            return RecvResult.unknown;
        }
        const r = await this.installCredentials(kes, { cert: bundle.opcert, coldVkey: this.coldVkey }, "kes-agent");
        if (r.ok) return RecvResult.ok;
        return r.kind === "outdated" ? RecvResult.keyOutdated : r.kind === "invalid-opcert" ? RecvResult.invalidOpCert : RecvResult.unknown;
    }

    /** Forget the hot credentials (kes-agent DropKey): no forging until a new pair arrives. */
    async dropCredentials(reason: string): Promise<number> {
        const run = this.installQueue.then(async () => {
            for (let waited = 0; this.forging && waited < 30_000; waited += 50) await Bun.sleep(50);
            if (this.forging) return RecvResult.unknown;
            if (this.kes) zeroise(this.kes.skey);
            this.kes = null;
            this.opcert = null;
            this.credentialsAt = new Date((this.node.now ?? Date.now)()).toISOString();
            logger.warn(`Block producer: KES key dropped (${reason}): no forging until new credentials arrive`);
            return RecvResult.ok;
        });
        this.installQueue = run.catch(() => undefined);
        return run;
    }

    /**
     * Reload the KES signing key and operational certificate from their files (cardano-node does
     * this on SIGHUP, so a KES rotation needs no restart). The new pair must pass the same checks
     * as at startup — issued by our cold key with a valid cold signature, certifying this KES key,
     * valid for the current KES period, and a counter the chain accepts (the last on-chain counter
     * or one above it) — otherwise the running credentials stay. The swap waits for a forge in
     * progress; the replaced KES secret is zeroed. Nothing about key material is logged.
     */
    reloadCredentials(): Promise<CredentialReload> {
        if (this.kesSource === "kes-agent") {
            return Promise.resolve({ ok: false, reason: "credentials come from the kes-agent (producer.kesAgentSocket); rotate them with kes-agent-control", kind: "other" });
        }
        if (this.reloading) return this.reloading;
        this.reloading = this.doReload().finally(() => { this.reloading = null; });
        return this.reloading;
    }

    private async doReload(): Promise<CredentialReload> {
        let kes: KesKey | null = null;
        let opcert: OperationalCert;
        try {
            opcert = readOperationalCert(this.cfg.opcertFile!);
            kes = loadKesSigningKey(this.cfg.kesSkeyFile!);
        } catch (err) {
            if (kes) zeroise(kes.skey);
            return this.rejectCredentials(`cannot read ${this.cfg.opcertFile} / the KES key: ${(err as Error)?.message ?? err}`, "files", "other");
        }
        return this.installCredentials(kes, opcert, "files");
    }

    private rejectCredentials(reason: string, source: "files" | "kes-agent", kind: "invalid-opcert" | "outdated" | "other"): CredentialReload {
        this.lastError = `credential reload rejected${source === "kes-agent" ? " (kes-agent)" : ""}: ${reason}`;
        const keeping = this.opcert ? `keeping counter ${this.opcert.cert.counter} period ${this.opcert.cert.kesPeriod}` : "no credentials installed";
        logger.error(`Block producer: KES / operational certificate ${source === "kes-agent" ? "from the kes-agent" : "reload"} rejected, ${keeping}: ${reason}`);
        return { ok: false, reason, kind };
    }

    /**
     * Check a new KES key + operational certificate pair and swap it in: the one path for a SIGHUP
     * reload and a kes-agent push. Takes ownership of `kes` (zeroed when rejected or replaced).
     */
    private installCredentials(kes: KesKey, opcert: OperationalCert, source: "files" | "kes-agent"): Promise<CredentialReload> {
        const run = this.installQueue.then(() => this.doInstall(kes, opcert, source));
        this.installQueue = run.catch(() => undefined);
        return run;
    }

    private async doInstall(kes: KesKey, opcert: OperationalCert, source: "files" | "kes-agent"): Promise<CredentialReload> {
        const fail = (reason: string, kind: "invalid-opcert" | "outdated" | "other" = "invalid-opcert"): CredentialReload => {
            zeroise(kes.skey);
            return this.rejectCredentials(reason, source, kind);
        };
        if (!bytesEq(opcert.coldVkey, this.coldVkey)) return fail("operational certificate was issued by a different cold key");
        let chainCounter: bigint | null;
        try { chainCounter = await this.node.lastOnChainOpcertCounter(this.poolId); }
        catch (err) { return fail(`on-chain counter unavailable: ${(err as Error)?.message ?? err}`, "other"); }
        const slot = slotAt((this.node.now ?? Date.now)(), this.node.network);
        const check = checkOperationalCert(opcert, {
            currentKesPeriod: kesPeriodOfSlot(slot, BigInt(this.node.genesis.slotsPerKESPeriod)),
            maxKesEvolutions: BigInt(this.node.genesis.maxKESEvolutions),
            lastOnChainCounter: chainCounter,
            kesVkey: kes.vkey,
        });
        if (!check.ok) return fail(check.reason);
        if (source === "kes-agent") {
            if (this.opcert && opcert.cert.counter < this.opcert.cert.counter) return fail(`certificate counter ${opcert.cert.counter} is older than the installed ${this.opcert.cert.counter}`, "outdated");
            if (!kesProbe(kes, opcert.cert.kesVkey)) return fail("the KES key does not sign for the certificate's KES verification key (self-sign probe failed)");
            // forward security: never hold an evolution older than the current slot needs
            const at = kesEvolution(kes);
            if (at < check.evolution) evolveKesTo(kes, check.evolution);
            else if (at > check.evolution) logger.warn(`Block producer: the kes-agent key is at evolution ${at}, ahead of this node's clock (${check.evolution}); slots before KES period ${opcert.cert.kesPeriod + BigInt(at)} cannot be forged with it`);
        }
        for (let waited = 0; this.forging && waited < 30_000; waited += 50) await Bun.sleep(50);
        if (this.forging) return fail("a forge is still running after 30 s; try again", "other");
        const old = this.kes, before = this.opcert?.cert ?? null;
        this.kes = kes;
        this.opcert = opcert;
        this.chainCounter = chainCounter;
        this.credentialsAt = new Date((this.node.now ?? Date.now)()).toISOString();
        if (old && old !== kes) zeroise(old.skey);
        if (this.lastError?.startsWith("credential reload rejected")) this.lastError = null;
        const same = !!before && before.counter === opcert.cert.counter && before.kesPeriod === opcert.cert.kesPeriod && bytesEq(before.kesVkey, opcert.cert.kesVkey);
        const from = source === "kes-agent" ? "from the kes-agent" : "reloaded";
        logger.info(`Block producer: credentials ${from}${same ? " (unchanged certificate)" : ""}: opcert counter ${before?.counter ?? "none"} → ${opcert.cert.counter}, KES period ${before?.kesPeriod ?? "none"} → ${opcert.cert.kesPeriod}, evolution ${check.evolution} of ${this.node.genesis.maxKESEvolutions}`);
        return { ok: true, counter: opcert.cert.counter, kesPeriod: opcert.cert.kesPeriod, evolution: check.evolution };
    }

    stats(): ProducerStats {
        const now = (this.node.now ?? Date.now)();
        const cur = slotAt(now, this.node.network);
        const net = this.node.network;
        const spk = BigInt(this.node.genesis.slotsPerKESPeriod);
        const maxEvo = this.node.genesis.maxKESEvolutions;
        const period = kesPeriodOfSlot(cur, spk);
        const oc = this.opcert?.cert ?? null;
        const evolution = oc ? Number(period - oc.kesPeriod) : null;
        const expiresSlot = oc ? (oc.kesPeriod + BigInt(maxEvo)) * spk : null;
        let next: bigint | null = null;
        const reports: LeaderSlotReport[] = [];
        // outcomes of slots the schedule pass has not (re)produced yet still show (a relaunch)
        const known = new Map<string, LeaderSlot>();
        for (const [k, o] of this.outcomes) if (!this.leaderSlots.has(k)) known.set(k, { slot: BigInt(k), slotInEpoch: BigInt(k) - firstSlotOfEpoch(epochForSlot(BigInt(k), net), net), time: new Date(slotStartMs(BigInt(k), net)).toISOString(), vrfOutputHex: "" } as LeaderSlot);
        void known;
        for (const s of [...this.leaderSlots.values(), ...known.values()].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))) {
            if (s.slot >= cur && (next == null || s.slot < next)) next = s.slot;
            const o = this.outcomes.get(s.slot.toString());
            // a past leader slot without a recorded forge or verdict was never evaluated (ticker skipped it)
            const outcome: LeaderSlotOutcome = o ? o.outcome : s.slot < cur ? "missed" : "upcoming";
            reports.push({ slot: s.slot.toString(), time: s.time, epoch: Number(epochForSlot(s.slot, net)), outcome, hash: o?.hash ?? null, note: o?.note ?? (outcome === "missed" && !o ? "no record: the producer was not running at that slot" : null) });
        }
        const epoch = Number(epochForSlot(cur, net));
        const sigma = this.sigmaByEpoch.get(epoch);
        const inEpoch = reports.filter((r) => r.epoch === epoch);
        const count = (k: LeaderSlotOutcome) => inEpoch.filter((r) => r.outcome === k).length;
        const ideal = sigma && sigma.den > 0n ? (Number(sigma.num) / Number(sigma.den)) * this.node.genesis.activeSlotsCoeff * Number(epochLengthSlots(epoch, net)) : null;
        return {
            poolId: this.poolId, vrfKeyHash: vrfKeyHashOf(this.vrf.vkey),
            opcert: oc ? { counter: oc.counter.toString(), kesPeriod: oc.kesPeriod.toString(), chainCounter: this.chainCounter?.toString() ?? null } : null,
            kesEvolution: evolution,
            kes: oc && evolution != null && expiresSlot != null
                ? { period: period.toString(), evolution, remaining: Math.max(0, maxEvo - evolution), maxEvolutions: maxEvo, expiresAt: new Date(slotStartMs(expiresSlot, net)).toISOString(), expiresSlot: expiresSlot.toString(), health: kesHealthOf(evolution, maxEvo), counter: this.chainCounter == null ? "unknown" : oc.counter < this.chainCounter ? "behind-chain" : oc.counter > this.chainCounter + 1n ? "ahead-of-chain" : "ok" }
                : null,
            credentials: { source: this.kesSource, installed: !!(this.kes && this.opcert), lastUpdate: this.credentialsAt, agent: this.agent?.state() ?? null },
            signedSlot: this.signedSlot?.toString() ?? null,
            missedLeaderChecks: this.ticker?.missedSlots ?? 0,
            scheduling: this.scheduling !== null,
            carriers: this.node.carriers?.() ?? null,
            scheduledEpochs: [...this.scheduled].sort((a, b) => a - b), leaderSlotsKnown: this.leaderSlots.size,
            nextLeaderSlot: next?.toString() ?? null,
            leaderSlots: reports,
            epochStats: {
                epoch, leader: inEpoch.length, ideal: ideal == null ? null : Math.round(ideal * 100) / 100,
                luck: ideal ? Math.round((inEpoch.length / ideal) * 1000) / 10 : null,
                // an adopted block that later confirmed counts in both columns, as gLiveView does
                adopted: count("adopted") + count("confirmed"), confirmed: count("confirmed"), invalid: count("invalid"), missed: count("missed"), ghosted: count("ghosted"), stolen: count("stolen"),
            },
            forged: this.forged, lastForgedSlot: this.lastForgedSlot?.toString() ?? null,
            lastError: this.lastError, dryRun: !!this.cfg.dryRun,
        };
    }

    /**
     * Settle the outcome of adopted blocks against our chain: still there and CONFIRM_DEPTH
     * deep → confirmed; replaced by another block at the slot → stolen; gone → ghosted. Runs
     * every 30 slots (index lookups only: this shares the applier thread) and refreshes the
     * on-chain opcert counter.
     */
    private async refreshOutcomes(): Promise<void> {
        if (!this.node.blockAtSlot) return;
        const tip = await this.node.tip();
        if (!tip) return;
        let changed = false;
        for (const [slot, o] of this.outcomes) {
            // A confirmed block is re-checked until it is k deep: a rollback deeper than
            // CONFIRM_DEPTH can still remove it (bug 130: the 2026-09-22 04:59 block stayed
            // "confirmed" after the network replaced it 13 s later and our node followed).
            if (o.outcome !== "adopted" && !(o.outcome === "confirmed" && o.blockNo != null && tip.blockNumber - BigInt(o.blockNo) < BigInt(FINAL_DEPTH))) continue;
            const b = await this.node.blockAtSlot(BigInt(slot));
            if (b && o.hash && b.hash === o.hash) {
                if (o.outcome === "adopted" && tip.blockNumber - BigInt(b.blockNo) >= BigInt(CONFIRM_DEPTH)) { o.outcome = "confirmed"; o.blockNo = b.blockNo; changed = true; }
            } else if (b) { changed = true; o.outcome = "stolen"; o.note = `slot battle lost to ${b.hash.slice(0, 16)}…`; logger.warn(`Block producer: our block at slot ${slot} was replaced by ${b.hash.slice(0, 16)}… (slot battle lost)`); this.greetingLost(o.hash); }
            else if (tip.slot > BigInt(slot) + 120n) { changed = true; o.outcome = "ghosted"; o.note = "rolled back, nothing at the slot"; logger.warn(`Block producer: our block at slot ${slot} is no longer on the chain (ghosted)`); this.greetingLost(o.hash); }
        }
        try { this.chainCounter = await this.node.lastOnChainOpcertCounter(this.poolId); } catch { /* keep the last value */ }
        if (changed) this.writeState(this.lastForgedSlot);
    }

    /** Schedules for the current epoch and, once its nonce is known, the next one. */
    private async ensureSchedules(slot: bigint): Promise<void> {
        if (this.scheduling) return this.scheduling;
        this.scheduling = (async () => {
            const epoch = Number(epochForSlot(slot, this.node.network));
            for (const e of [epoch, epoch + 1]) {
                const nonce = await this.node.nonceFor(e);
                if (this.scheduled.has(e)) {
                    // Recompute when the nonce moved. The evolver's peek is exact once the candidate
                    // nonce is frozen (ηh is carried from the previous boundary), so this only fires
                    // after a rollback across the freeze or a stale external value; it keeps a
                    // schedule from ever outliving the nonce it was computed from.
                    if (!nonce || nonce === this.scheduledNonce.get(e)) continue;
                    logger.warn(`Block producer: η0 for epoch ${e} changed (${this.scheduledNonce.get(e)?.slice(0, 12)}… → ${nonce.slice(0, 12)}…): recomputing the schedule`);
                    for (const [k, v] of this.leaderSlots) if (Number(epochForSlot(v.slot, this.node.network)) === e) this.leaderSlots.delete(k);
                    this.scheduled.delete(e);
                }
                if (!nonce) { if (e === epoch) logger.warn(`Block producer: η0 for epoch ${e} unknown yet`); continue; }
                const sigma = await this.node.sigmaFor(e, this.poolId);
                if (!sigma) { logger.warn(`Block producer: no stake snapshot for epoch ${e} yet`); continue; }
                this.sigmaByEpoch.set(e, sigma);
                if (sigma.num === 0n) {
                    // No stake in the snapshot that decides this epoch: no slot can be ours, and the
                    // VRF pass over 86 400 slots (≈ 3.5 min on preview) would only delay startup.
                    this.scheduled.add(e);
                    this.scheduledNonce.set(e, nonce);
                    logger.info(`Block producer: epoch ${e} schedule: no stake in its snapshot, 0 leader slot(s)`);
                    continue;
                }
                const t0 = performance.now();
                // A relaunch must not redo the VRF pass (72–329 s): the state file keeps each
                // epoch's slots with the nonce they were computed from.
                const cached = this.cachedSchedules.get(e);
                const slots = cached && cached.nonce === nonce && cached.sigma === `${sigma.num}/${sigma.den}`
                    ? cached.slots
                    : await this.node.schedule({ epoch: e, nonceHex: nonce, sigma, vrf: this.vrf });
                if (!(cached && cached.slots === slots)) this.cachedSchedules.set(e, { nonce, sigma: `${sigma.num}/${sigma.den}`, slots });
                for (const s of slots) this.leaderSlots.set(s.slot.toString(), s);
                this.scheduled.add(e);
                this.scheduledNonce.set(e, nonce);
                for (const k of this.cachedSchedules.keys()) if (k < epoch - 1) this.cachedSchedules.delete(k);
                this.writeState(this.lastForgedSlot);
                // forget epochs before the current one
                for (const [k, v] of this.leaderSlots) if (Number(epochForSlot(v.slot, this.node.network)) < epoch) this.leaderSlots.delete(k);
                for (const k of this.scheduled) if (k < epoch) this.scheduled.delete(k);
                for (const k of this.sigmaByEpoch.keys()) if (k < epoch - 1) this.sigmaByEpoch.delete(k);
                for (const [k] of this.outcomes) if (Number(epochForSlot(BigInt(k), this.node.network)) < epoch - 1) this.outcomes.delete(k);
                logger.info(`Block producer: epoch ${e} schedule: ${slots.length} leader slot(s), σ = ${sigma.num}/${sigma.den} (${cached && cached.slots === slots ? "from the state file" : ((performance.now() - t0) / 1000).toFixed(1) + " s"})${slots.length ? `, first ${slots[0]!.slot} at ${slots[0]!.time}` : ""}`);
            }
        })().catch((err) => { this.lastError = `schedule: ${err?.message ?? err}`; logger.error("Block producer: schedule failed:", err); }).finally(() => { this.scheduling = null; });
        return this.scheduling;
    }

    private async onSlot(slot: bigint, nowMs: number): Promise<void> {
        // epoch boundary (or missing next-epoch schedule): refresh in the background
        if (slot === firstSlotOfEpoch(epochForSlot(slot, this.node.network), this.node.network) || !this.scheduled.has(Number(epochForSlot(slot, this.node.network)) + 1) || slot % 30n === 0n) {
            void this.ensureSchedules(slot);
        }
        if (slot % 30n === 0n) this.refreshOutcomes().catch((err) => logger.warn(`Block producer: outcome refresh failed: ${(err as Error)?.message ?? err}`));
        if (slot % 30n === 15n) this.sweepMempool(slot).catch((err) => logger.warn(`Block producer: mempool sweep failed: ${(err as Error)?.message ?? err}`));
        // Propagation readiness: 10 and 2 minutes before a leader slot, say who would carry the block.
        for (const ahead of [600n, 120n]) {
            const s = this.leaderSlots.get((slot + ahead).toString());
            if (!s || !this.node.carriers) continue;
            const c = this.node.carriers();
            const n = c.inbound.length + c.duplex.length;
            const msg = `Block producer: leader slot ${s.slot} in ${ahead / 60n} min — ${n} carrier(s) attached (${c.inbound.length} inbound pulling, ${c.duplex.length} duplex)${c.publicReachable === false ? "; PUBLIC --port UNREACHABLE" : ""}`;
            if (n === 0 || c.publicReachable === false) logger.warn(msg + ": a block forged now would not leave this node"); else logger.info(msg);
        }
        noteForgeEvent("about-to-lead");
        if (!this.leaderSlots.has(slot.toString())) { noteForgeEvent("node-not-leader"); return; }
        noteForgeEvent("node-is-leader");
        if (!this.kes || !this.opcert) {
            noteForgeEvent("could-not-forge");
            const why = this.kesSource === "kes-agent" ? `no KES key: the kes-agent at ${this.cfg.kesAgentSocket} has not sent one${this.agent?.state().connected ? "" : " (not connected)"}` : "no KES key installed";
            this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: why });
            this.writeState(this.lastForgedSlot);
            logger.warn(`Block producer: leader for slot ${slot} but not forging: ${why}`);
            return;
        }
        const tip = await this.node.tip();
        const verdict = decideForge(slot, nowMs, {
            leaderSlots: new Set(this.leaderSlots.keys()),
            tip: tip ? { slot: tip.slot, blockNumber: tip.blockNumber, hash: Uint8Array.from(Buffer.from(tip.hashHex, "hex")) } : null,
            lastForgedSlot: this.forgeGuardSlot(),
        }, { network: this.node.network });
        if (!verdict.forge) { noteForgeEvent("could-not-forge"); this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: verdict.reason }); this.writeState(this.lastForgedSlot); logger.warn(`Block producer: leader for slot ${slot} but not forging: ${verdict.reason}`); return; }
        if (this.cfg.dryRun) { this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: "dry run" }); logger.info(`Block producer (dry run): would forge slot ${slot} as block ${verdict.blockNumber} on ${tip!.hashHex.slice(0, 16)}…`); return; }
        if (this.forging) { this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: "a forge was still running" }); return; }
        this.forging = true;
        try {
            await this.forgeAndAdopt(slot, verdict.blockNumber, verdict.prevHash!, verdict.epoch);
        } finally {
            this.forging = false;
        }
    }

    /** No slot at or below this is ever forged: the higher of the last adopted forge and the last signed slot. */
    private forgeGuardSlot(): bigint | null {
        const a = this.lastForgedSlot, b = this.signedSlot;
        return a == null ? b : b == null ? a : a > b ? a : b;
    }

    private async forgeAndAdopt(slot: bigint, blockNumber: bigint, prevHash: Uint8Array, epoch: number): Promise<void> {
        // Credentials are captured once: a swap waits for `forging` to clear, so they cannot change mid-slot.
        const kes = this.kes, opcert = this.opcert;
        if (!kes || !opcert) { this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: "no KES key installed" }); return; }
        const guard = this.forgeGuardSlot();
        if (guard != null && slot <= guard) {
            this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: `slot ${slot} is not after the last signed slot ${guard}` });
            logger.error(`Block producer: refusing to forge slot ${slot}: a header was already signed for slot ${guard}`);
            return;
        }
        const nonceHex = await this.node.nonceFor(epoch);
        if (!nonceHex) { this.lastError = `no η0 for epoch ${epoch}`; this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: this.lastError }); return; }
        const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
        const protocolVersion = this.cfg.headerProtocolVersion ?? await this.node.protocolVersion(epoch);
        const maxBody = await this.node.maxBlockBodySize(epoch);
        const txs: TxParts[] = [];
        // Temporary: the first block on a network opens with "Gerolamo was here!" (once per network).
        let greeting: TxParts | null = null;
        if (!this.greeted && this.node.greetingTx) {
            try { const g = await this.node.greetingTx(); if (g) { greeting = splitTx(g.hash, g.bytes); txs.push(greeting); } }
            catch (err) { logger.warn(`Block producer: greeting transaction not built: ${(err as Error)?.message ?? err}`); }
        }
        // Mempool transactions: the validating mempool's snapshot for this slot (re-applied in
        // order, within the block's capacity), or — without one — the stored transactions minus
        // what cannot be in this block (expired, spent inputs; at 08:44 UTC 2026-09-12 an
        // unvalidated mempool held 69 transactions of which most were stale).
        const validated = !!this.node.mempoolSnapshot;
        // Dijkstra (era 8): the mempool still validates Conway transactions only, so a Dijkstra block is
        // forged empty until the mempool learns the era (bug 432, open)
        const candidates = this.node.era >= 8 ? [] : validated ? await this.node.mempoolSnapshot!(slot) : await this.node.mempoolTxs();
        const stale = new Set<string>();
        if (!validated && this.node.txSanity && candidates.length) {
            try { for (const h of await this.node.txSanity(candidates, slot)) stale.add(Buffer.from(h).toString("hex")); }
            catch (err) { logger.warn(`Block producer: mempool sanity check failed: ${(err as Error)?.message ?? err}`); }
        }
        for (const t of candidates) {
            if (stale.has(Buffer.from(t.hash).toString("hex"))) continue;
            try { txs.push(splitTx(t.hash, t.bytes)); } catch { /* malformed: leave it, the mempool owner drops it */ }
        }
        if (stale.size) { logger.warn(`Block producer: ${stale.size} stale transaction(s) left out of slot ${slot} (${txs.length} candidates left)`); this.node.dropFromMempool(candidates.filter((t) => stale.has(Buffer.from(t.hash).toString("hex"))).map((t) => t.hash)).catch(() => undefined); }
        // Our rules name the transactions they reject ("tx[i]: …"): drop those and retry within a
        // time budget, then ALWAYS the empty body (2026-09-12 08:44 UTC: five rounds of peeling
        // two or three at a time ended with the slot marked invalid and no empty attempt).
        const culprits = new Set<TxParts>();
        const t0 = performance.now();
        let attempt: { body: BodySegments; included: TxParts[] } | null = txs.length ? (() => { const a = assembleBody(txs, maxBody); return a.included.length ? { body: a.segments, included: a.included } : null; })() : null;
        let emptyTried = false;
        const signed: string[] = []; // header hashes signed for this slot (attempts)
        // Write-ahead: the slot is recorded as signed (durably) before the first signature. If that
        // cannot be persisted the slot is given up: a restart could not know a block went out.
        this.signedSlot = slot;
        if (!this.writeState(this.lastForgedSlot)) {
            this.lastError = `slot ${slot} not forged: the state file ${this.cfg.stateFile} cannot be written (one-block-per-slot guard)`;
            this.outcomes.set(slot.toString(), { outcome: "missed", hash: null, note: this.lastError });
            logger.error(`Block producer: ${this.lastError}`);
            return;
        }
        for (let round = 0; round < 12; round++) {
            if (!attempt) { if (emptyTried) break; attempt = { body: EMPTY_BODY, included: [] }; emptyTried = true; }
            if (round > 0) {
                // A retry signs a different header for the same slot. Only safe while the earlier attempt
                // is not on our chain: if adopt threw after applying it, stop here.
                const t = await this.node.tip().catch(() => null);
                if (t && t.slot >= slot) {
                    if (signed.includes(t.hashHex.toLowerCase())) {
                        // the attempt that "failed" is on our chain after all: it is the slot's block
                        this.lastForgedSlot = slot;
                        this.forged++;
                        this.outcomes.set(slot.toString(), { outcome: "adopted", hash: t.hashHex.toLowerCase(), note: `block ${blockNumber} (adopt reported an error after applying it)` });
                        noteForgedBlock(t.hashHex);
                        this.writeState(slot);
                        logger.warn(`Block producer: slot ${slot}: adopt reported an error but block ${t.hashHex.slice(0, 16)}… is our tip; not retrying`);
                        return;
                    }
                    logger.warn(`Block producer: not retrying slot ${slot}: the chain tip is already at slot ${t.slot} (${t.hashHex.slice(0, 16)}…)`);
                    break;
                }
            }
            const forged = forgeBlock({
                era: this.node.era, blockNumber, slot, prevHash, nonce, coldVkey: this.coldVkey, vrf: this.vrf, kes, opcert: opcert.cert,
                protocolVersion, slotsPerKESPeriod: BigInt(this.node.genesis.slotsPerKESPeriod), body: attempt.body,
            });
            signed.push(Buffer.from(forged.headerHash).toString("hex"));
            noteForgeEvent("forged", slot);
            try {
                await this.node.adopt(forged.blockFetchBytes);
            } catch (err) {
                noteForgeEvent("forged-invalid");
                const msg = String((err as Error)?.message ?? err);
                this.lastError = `block for slot ${slot} rejected by our own rules (${attempt.included.length} tx): ${msg}`;
                logger.error(`Block producer: ${this.lastError}`);
                if (!attempt.included.length) break; // even the empty body failed: give up
                const bad = new Set<number>();
                for (const m of msg.matchAll(/tx\[(\d+)\]/g)) bad.add(Number(m[1]));
                const keep = attempt.included.filter((_t, i) => !bad.has(i));
                for (const t of attempt.included) if (!keep.includes(t)) culprits.add(t);
                const overBudget = performance.now() - t0 > 1500;
                if (bad.size && keep.length && !overBudget) {
                    const again = assembleBody(keep, maxBody);
                    if (again.included.length) { attempt = { body: again.segments, included: again.included }; logger.warn(`Block producer: retrying slot ${slot} without ${bad.size} rejected transaction(s) (${keep.length} left)`); continue; }
                }
                if (overBudget) logger.warn(`Block producer: retry budget spent on slot ${slot}; forging the empty body`);
                attempt = null; // → empty body next
                continue;
            }
            noteForgeEvent("adopted");
            this.lastForgedSlot = slot;
            this.forged++;
            this.outcomes.set(slot.toString(), { outcome: "adopted", hash: Buffer.from(forged.headerHash).toString("hex"), note: `block ${blockNumber}, ${attempt.included.length} tx` });
            noteForgedBlock(Buffer.from(forged.headerHash).toString("hex"));
            if (greeting && attempt.included.includes(greeting)) { this.greeted = true; this.greetingBlock = Buffer.from(forged.headerHash).toString("hex"); logger.info(`Block producer: "Gerolamo was here!" is in block ${blockNumber} (tx ${Buffer.from(greeting.hash).toString("hex").slice(0, 12)}…)`); }
            this.writeState(slot);
            const evict = [...attempt.included, ...culprits].map((t) => t.hash);
            if (evict.length) await this.node.dropFromMempool(evict).catch(() => undefined);
            if (culprits.size) logger.warn(`Block producer: evicted ${culprits.size} transaction(s) our rules rejected from the mempool`);
            logger.info(`Block producer: forged block ${blockNumber} at slot ${slot} (${attempt.included.length} tx, ${forged.blockFetchBytes.length} bytes) hash ${Buffer.from(forged.headerHash).toString("hex").slice(0, 16)}… KES evolution ${forged.kesEvolution}`);
            return;
        }
        if (culprits.size) await this.node.dropFromMempool([...culprits].map((t) => t.hash)).catch(() => undefined);
        this.outcomes.set(slot.toString(), { outcome: "invalid", hash: null, note: this.lastError });
        this.writeState(this.lastForgedSlot);
    }

    /** The block that carried the greeting left the chain: greet again in the next block. */
    private greetingLost(hash: string | null): void {
        if (!hash || !this.greeted || this.greetingBlock !== hash.toLowerCase()) return;
        this.greeted = false;
        this.greetingBlock = null;
        logger.warn(`Block producer: the block carrying "Gerolamo was here!" (${hash.slice(0, 16)}…) is not on the chain; the next block greets again`);
    }

    /** Drop mempool transactions that can no longer be in a block (expired, inputs spent). */
    private async sweepMempool(slot: bigint): Promise<void> {
        if (this.node.mempoolSnapshot || !this.node.txSanity) return; // a validating mempool prunes itself
        const txs = await this.node.mempoolTxs();
        if (!txs.length) return;
        const bad = await this.node.txSanity(txs, slot);
        if (bad.length) { await this.node.dropFromMempool(bad); logger.info(`Block producer: mempool sweep dropped ${bad.length} stale transaction(s) of ${txs.length}`); }
    }

    private readState(): bigint | null {
        const f = this.cfg.stateFile;
        if (!f || !existsSync(f)) return null;
        let j: any;
        try { j = JSON.parse(readFileSync(f, "utf8")); }
        catch (err) {
            // The file exists but is unreadable: which slots were already signed is unknown. Treat every
            // slot up to now as signed, so only future slots are forged (none of them can have been).
            this.signedSlot = slotAt((this.node.now ?? Date.now)(), this.node.network);
            logger.error(`Block producer: state file ${f} is unreadable (${(err as Error)?.message ?? err}); no slot up to ${this.signedSlot} will be forged`);
            return null;
        }
        if (j?.signedSlot != null) { try { this.signedSlot = BigInt(j.signedSlot); } catch { /* malformed: lastForgedSlot still guards */ } }
        let last: bigint | null = null;
        try { if (j?.lastForgedSlot != null) last = BigInt(j.lastForgedSlot); }
        catch { this.signedSlot = slotAt((this.node.now ?? Date.now)(), this.node.network); logger.error(`Block producer: state file ${f}: lastForgedSlot unreadable; no slot up to ${this.signedSlot} will be forged`); }
        try {
            this.greeted = j.greeted === this.node.network;
            this.greetingBlock = typeof j.greetingBlock === "string" ? j.greetingBlock.toLowerCase() : null;
            // outcomes survive a relaunch (2026-09-12 06:51 UTC: the first accepted block showed as
            // "missed" on the panel after a restart because the map lived in memory only)
            if (j.outcomes && typeof j.outcomes === "object") {
                for (const [slot, o] of Object.entries(j.outcomes as Record<string, { outcome: LeaderSlotOutcome; hash: string | null; note: string | null; blockNo?: number }>)) {
                    if (o && typeof o.outcome === "string") this.outcomes.set(slot, { outcome: o.outcome, hash: o.hash ?? null, note: o.note ?? null });
                }
            }
            if (typeof j.forged === "number") this.forged = j.forged;
            if (j.schedules && typeof j.schedules === "object") {
                for (const [e, c] of Object.entries(j.schedules as Record<string, { nonce: string; sigma: string; slots: Array<{ slot: string; slotInEpoch: string; time: string; vrfOutputHex: string }> }>)) {
                    if (c && typeof c.nonce === "string" && Array.isArray(c.slots)) this.cachedSchedules.set(Number(e), { nonce: c.nonce, sigma: String(c.sigma ?? ""), slots: c.slots.map((s) => ({ slot: BigInt(s.slot), slotInEpoch: BigInt(s.slotInEpoch), time: s.time, vrfOutputHex: s.vrfOutputHex })) });
                }
            }
        } catch (err) { logger.warn(`Block producer: state file ${f}: some fields unreadable (${(err as Error)?.message ?? err})`); }
        return last;
    }

    /**
     * Persist the state file atomically (temporary file, fsync, rename): a crash mid-write leaves
     * the previous version, never a truncated file. False when it could not be written.
     */
    private writeState(slot: bigint | null): boolean {
        const f = this.cfg.stateFile;
        if (!f) return true;
        const tmp = `${f}.tmp`;
        try {
            const outcomes = Object.fromEntries([...this.outcomes].slice(-64));
            const schedules = Object.fromEntries([...this.cachedSchedules].map(([e, c]) => [e, { nonce: c.nonce, sigma: c.sigma, slots: c.slots.map((s) => ({ slot: s.slot.toString(), slotInEpoch: s.slotInEpoch.toString(), time: s.time, vrfOutputHex: s.vrfOutputHex })) }]));
            const body = JSON.stringify({ poolId: this.poolId, lastForgedSlot: slot?.toString() ?? null, signedSlot: this.signedSlot?.toString() ?? null, greeted: this.greeted ? this.node.network : null, greetingBlock: this.greetingBlock, forged: this.forged, outcomes, schedules, at: new Date().toISOString() }) + "\n";
            const fd = openSync(tmp, "w", 0o600);
            try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(tmp, f);
            return true;
        } catch (err) { logger.warn("Block producer: could not persist state:", err); return false; }
    }
}

/** Production node adapter: DB + orchestrator + shared mempool + schedule worker. */
export function nodeAdapter(opts: {
    network: EpochNetwork; era: number; genesis: ShelleyGenesisLike;
    nonceFor: (epoch: number) => Promise<string | null>;
    adopt: (bytes: Uint8Array) => Promise<unknown>;
    mempoolTxs: () => Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>>;
    mempoolSnapshot?: (slot: bigint) => Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>>;
    greetingTx?: () => Promise<{ hash: Uint8Array; bytes: Uint8Array } | null>;
    dropFromMempool: (hashes: Uint8Array[]) => Promise<void>;
}): ProducerNode {
    return {
        network: opts.network, era: opts.era, genesis: opts.genesis,
        nonceFor: opts.nonceFor,
        async sigmaFor(epoch, poolId) {
            const d = await poolStakeForEpoch(epoch);
            if (!d || d.total <= 0n) return null;
            return { num: d.stake.get(poolId.toLowerCase()) ?? 0n, den: d.total };
        },
        tip: async () => {
            const t = await getChainTipFromHeader();
            if (!t) return null;
            if (t.blockNumber !== t.dbBlockNumber && !tipDriftLogged) { tipDriftLogged = true; logger.warn(`Block producer: this DB counts the tip as block ${t.dbBlockNumber} but its header says ${t.blockNumber}; forging with the header's number`); }
            return { slot: t.slot, blockNumber: t.blockNumber, hashHex: t.hashHex };
        },
        async protocolVersion(epoch) {
            const raw = await readEpochParamsRaw(epoch);
            const major = Number(raw?.protocol_major_ver ?? raw?.protocol_major ?? 0), minor = Number(raw?.protocol_minor_ver ?? raw?.protocol_minor ?? 0);
            if (!major) throw new Error(`no protocol version for epoch ${epoch}`);
            return { major, minor };
        },
        async maxBlockBodySize(epoch) {
            const raw = await readEpochParamsRaw(epoch);
            return Number(raw?.max_block_size ?? raw?.max_block_body_size ?? 90_112);
        },
        async lastOnChainOpcertCounter(poolId) {
            const s = await opcertCounterState(poolId);
            return s ? BigInt(s.counter) : null;
        },
        mempoolTxs: opts.mempoolTxs,
        mempoolSnapshot: opts.mempoolSnapshot,
        greetingTx: opts.greetingTx,
        dropFromMempool: opts.dropFromMempool,
        adopt: async (b) => { await opts.adopt(b); },
        schedule: scheduleInWorker,
        blockAtSlot,
        async txSanity(txs, slot) {
            const bad: Uint8Array[] = [];
            for (const t of txs) {
                try {
                    const tx = Tx.fromCbor(t.bytes);
                    const body: any = tx.body;
                    if (body.ttl != null && BigInt(body.ttl) < slot) { bad.push(t.hash); continue; }
                    if (body.validityIntervalStart != null && BigInt(body.validityIntervalStart) > slot) { bad.push(t.hash); continue; }
                    let missing = false;
                    for (const i of [...(body.inputs ?? []), ...(body.collateralInputs ?? [])]) {
                        const ref = i?.utxoRef ?? i;
                        const key = `${String(ref.id).toLowerCase()}:${Number(ref.index)}`;
                        const ur = ledgerUtxoReads();
                        const present = ur ? ur.has(key) : ((await sql`SELECT 1 FROM utxo WHERE utxo_ref = ${key}`.values()) as unknown[][]).length > 0;
                        if (!present) { missing = true; break; }
                    }
                    if (missing) bad.push(t.hash);
                } catch { bad.push(t.hash); } // unparsable: never forgeable
            }
            return bad;
        },
    };
}

let tipDriftLogged = false;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: LeaderSlot[]) => void; reject: (e: Error) => void }>();

/** Run leaderSlotsForEpoch in a dedicated worker; the VRF secret is copied for the call and zeroed there. */
export function scheduleInWorker(input: { epoch: number; nonceHex: string; sigma: { num: bigint; den: bigint }; vrf: VrfKey; network?: EpochNetwork; activeSlotsCoeff?: number }): Promise<LeaderSlot[]> {
    if (!worker) {
        worker = new Worker(new URL("./scheduleWorker.ts", import.meta.url).href);
        worker.postMessage(settingsMessage());
        worker.onmessage = (ev: MessageEvent) => {
            const { id, slots, error } = ev.data as { id: number; slots?: any[]; error?: string };
            const p = pending.get(id); pending.delete(id);
            if (!p) return;
            if (error) p.reject(new Error(error));
            else p.resolve((slots ?? []).map((s) => ({ slot: BigInt(s.slot), slotInEpoch: BigInt(s.slotInEpoch), time: s.time, vrfOutputHex: s.vrfOutputHex })));
        };
    }
    const id = nextId++;
    const vrfSkey = Uint8Array.from(input.vrf.skey);
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, input: { epoch: input.epoch, nonceHex: input.nonceHex, sigma: { num: input.sigma.num.toString(), den: input.sigma.den.toString() }, activeSlotsCoeff: input.activeSlotsCoeff ?? 0.05, network: input.network ?? "preview", vrfSkey, vrfVkey: Uint8Array.from(input.vrf.vkey) } }, [vrfSkey.buffer]);
    });
}
