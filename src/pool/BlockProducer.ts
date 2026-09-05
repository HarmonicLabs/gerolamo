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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getChainTip } from "../db";
import { poolStakeForEpoch, opcertCounterState } from "../db/leaderState";
import { readEpochParamsRaw } from "../consensus/epochParams";
import { epochForSlot, firstSlotOfEpoch, type EpochNetwork } from "../utils/epochFromSlotCalculations";
import { logger } from "../utils/logger";
import { assembleBody, splitTx, type TxParts } from "./bodyAssembly";
import { EMPTY_BODY, forgeBlock, type BodySegments } from "./forge";
import {
    checkOperationalCert, kesPeriodOfSlot, loadColdVerificationKey, loadKesSigningKey, loadVrfSigningKey, poolIdOf, readOperationalCert, vrfKeyHashOf,
    type KesKey, type OperationalCert, type VrfKey,
} from "./keystore";
import type { LeaderSlot } from "./leaderSchedule";
import { decideForge, SlotTicker, slotAt } from "./slotClock";

export interface ProducerKeysConfig {
    coldVkeyFile: string;
    kesSkeyFile: string;
    vrfSkeyFile: string;
    opcertFile: string;
    stateFile?: string;
    dryRun?: boolean;
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
    dropFromMempool(hashes: Uint8Array[]): Promise<void>;
    adopt(blockFetchBytes: Uint8Array): Promise<void>;
    /** Leader schedule for an epoch (worker in production, in-process in tests). */
    schedule(input: { epoch: number; nonceHex: string; sigma: { num: bigint; den: bigint }; vrf: VrfKey }): Promise<LeaderSlot[]>;
    now?: () => number;
}

export interface ProducerStats {
    poolId: string;
    vrfKeyHash: string;
    opcert: { counter: string; kesPeriod: string };
    kesEvolution: number;
    scheduledEpochs: number[];
    leaderSlotsKnown: number;
    nextLeaderSlot: string | null;
    forged: number;
    lastForgedSlot: string | null;
    lastError: string | null;
    dryRun: boolean;
}

export class BlockProducer {
    readonly poolId: string;
    private readonly coldVkey: Uint8Array;
    private readonly vrf: VrfKey;
    private readonly kes: KesKey;
    private readonly opcert: OperationalCert;
    private readonly leaderSlots = new Map<string, LeaderSlot>(); // slot → entry
    private readonly scheduled = new Set<number>();
    private scheduling: Promise<void> | null = null;
    private ticker: SlotTicker | null = null;
    private lastForgedSlot: bigint | null = null;
    private forged = 0;
    private lastError: string | null = null;
    private forging = false;

    constructor(private readonly cfg: ProducerKeysConfig, private readonly node: ProducerNode) {
        this.coldVkey = loadColdVerificationKey(cfg.coldVkeyFile);
        this.poolId = poolIdOf(this.coldVkey);
        this.vrf = loadVrfSigningKey(cfg.vrfSkeyFile);
        this.kes = loadKesSigningKey(cfg.kesSkeyFile);
        this.opcert = readOperationalCert(cfg.opcertFile);
        if (Buffer.from(this.opcert.coldVkey).toString("hex") !== Buffer.from(this.coldVkey).toString("hex")) {
            throw new Error("operational certificate was issued by a different cold key");
        }
        this.lastForgedSlot = this.readState();
    }

    /** Verify the certificate against the current slot and the chain, then schedule and start ticking. */
    async start(): Promise<void> {
        const now = (this.node.now ?? Date.now)();
        const slot = slotAt(now, this.node.network);
        const check = checkOperationalCert(this.opcert, {
            currentKesPeriod: kesPeriodOfSlot(slot, BigInt(this.node.genesis.slotsPerKESPeriod)),
            maxKesEvolutions: BigInt(this.node.genesis.maxKESEvolutions),
            lastOnChainCounter: await this.node.lastOnChainOpcertCounter(this.poolId),
            kesVkey: this.kes.vkey,
        });
        if (!check.ok) throw new Error(`operational certificate rejected: ${check.reason}`);
        logger.info(`Block producer: pool ${this.poolId}, VRF ${vrfKeyHashOf(this.vrf.vkey).slice(0, 16)}…, opcert counter ${this.opcert.cert.counter} period ${this.opcert.cert.kesPeriod}, KES evolution ${check.evolution}${this.cfg.dryRun ? " (dry run: no forging)" : ""}`);
        await this.ensureSchedules(slot);
        this.ticker = new SlotTicker({ network: this.node.network, now: this.node.now }, (s, nowMs) => { void this.onSlot(s, nowMs); });
        this.ticker.start();
    }

    stop(): void {
        this.ticker?.stop();
        this.ticker = null;
    }

    stats(): ProducerStats {
        const now = (this.node.now ?? Date.now)();
        const cur = slotAt(now, this.node.network);
        let next: bigint | null = null;
        for (const s of this.leaderSlots.values()) if (s.slot >= cur && (next == null || s.slot < next)) next = s.slot;
        return {
            poolId: this.poolId, vrfKeyHash: vrfKeyHashOf(this.vrf.vkey),
            opcert: { counter: this.opcert.cert.counter.toString(), kesPeriod: this.opcert.cert.kesPeriod.toString() },
            kesEvolution: Number(kesPeriodOfSlot(cur, BigInt(this.node.genesis.slotsPerKESPeriod)) - this.opcert.cert.kesPeriod),
            scheduledEpochs: [...this.scheduled].sort((a, b) => a - b), leaderSlotsKnown: this.leaderSlots.size,
            nextLeaderSlot: next?.toString() ?? null, forged: this.forged, lastForgedSlot: this.lastForgedSlot?.toString() ?? null,
            lastError: this.lastError, dryRun: !!this.cfg.dryRun,
        };
    }

    /** Schedules for the current epoch and, once its nonce is known, the next one. */
    private async ensureSchedules(slot: bigint): Promise<void> {
        if (this.scheduling) return this.scheduling;
        this.scheduling = (async () => {
            const epoch = Number(epochForSlot(slot, this.node.network));
            for (const e of [epoch, epoch + 1]) {
                if (this.scheduled.has(e)) continue;
                const nonce = await this.node.nonceFor(e);
                if (!nonce) { if (e === epoch) logger.warn(`Block producer: η0 for epoch ${e} unknown yet`); continue; }
                const sigma = await this.node.sigmaFor(e, this.poolId);
                if (!sigma) { logger.warn(`Block producer: no stake snapshot for epoch ${e} yet`); continue; }
                const t0 = performance.now();
                const slots = await this.node.schedule({ epoch: e, nonceHex: nonce, sigma, vrf: this.vrf });
                for (const s of slots) this.leaderSlots.set(s.slot.toString(), s);
                this.scheduled.add(e);
                // forget epochs before the current one
                for (const [k, v] of this.leaderSlots) if (Number(epochForSlot(v.slot, this.node.network)) < epoch) this.leaderSlots.delete(k);
                for (const k of this.scheduled) if (k < epoch) this.scheduled.delete(k);
                logger.info(`Block producer: epoch ${e} schedule: ${slots.length} leader slot(s), σ = ${sigma.num}/${sigma.den} (${((performance.now() - t0) / 1000).toFixed(1)} s)${slots.length ? `, first ${slots[0]!.slot} at ${slots[0]!.time}` : ""}`);
            }
        })().catch((err) => { this.lastError = `schedule: ${err?.message ?? err}`; logger.error("Block producer: schedule failed:", err); }).finally(() => { this.scheduling = null; });
        return this.scheduling;
    }

    private async onSlot(slot: bigint, nowMs: number): Promise<void> {
        // epoch boundary (or missing next-epoch schedule): refresh in the background
        if (slot === firstSlotOfEpoch(epochForSlot(slot, this.node.network), this.node.network) || !this.scheduled.has(Number(epochForSlot(slot, this.node.network)) + 1)) {
            void this.ensureSchedules(slot);
        }
        if (!this.leaderSlots.has(slot.toString())) return;
        const tip = await this.node.tip();
        const verdict = decideForge(slot, nowMs, {
            leaderSlots: new Set(this.leaderSlots.keys()),
            tip: tip ? { slot: tip.slot, blockNumber: tip.blockNumber, hash: Uint8Array.from(Buffer.from(tip.hashHex, "hex")) } : null,
            lastForgedSlot: this.lastForgedSlot,
        }, { network: this.node.network });
        if (!verdict.forge) { logger.warn(`Block producer: leader for slot ${slot} but not forging: ${verdict.reason}`); return; }
        if (this.cfg.dryRun) { logger.info(`Block producer (dry run): would forge slot ${slot} as block ${verdict.blockNumber} on ${tip!.hashHex.slice(0, 16)}…`); return; }
        if (this.forging) return;
        this.forging = true;
        try {
            await this.forgeAndAdopt(slot, verdict.blockNumber, verdict.prevHash!, verdict.epoch);
        } finally {
            this.forging = false;
        }
    }

    private async forgeAndAdopt(slot: bigint, blockNumber: bigint, prevHash: Uint8Array, epoch: number): Promise<void> {
        const nonceHex = await this.node.nonceFor(epoch);
        if (!nonceHex) { this.lastError = `no η0 for epoch ${epoch}`; return; }
        const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
        const protocolVersion = await this.node.protocolVersion(epoch);
        const maxBody = await this.node.maxBlockBodySize(epoch);
        const txs: TxParts[] = [];
        for (const t of await this.node.mempoolTxs()) {
            try { txs.push(splitTx(t.hash, t.bytes)); } catch { /* malformed: leave it, the mempool owner drops it */ }
        }
        const attempts: Array<{ body: BodySegments; included: TxParts[] }> = [];
        const assembled = assembleBody(txs, maxBody);
        if (assembled.included.length) attempts.push({ body: assembled.segments, included: assembled.included });
        attempts.push({ body: EMPTY_BODY, included: [] });
        for (const attempt of attempts) {
            const forged = forgeBlock({
                era: this.node.era, blockNumber, slot, prevHash, nonce, coldVkey: this.coldVkey, vrf: this.vrf, kes: this.kes, opcert: this.opcert.cert,
                protocolVersion, slotsPerKESPeriod: BigInt(this.node.genesis.slotsPerKESPeriod), body: attempt.body,
            });
            try {
                await this.node.adopt(forged.blockFetchBytes);
            } catch (err) {
                this.lastError = `block for slot ${slot} rejected by our own rules (${attempt.included.length} tx): ${(err as Error)?.message ?? err}`;
                logger.error(`Block producer: ${this.lastError}`);
                continue; // retry with an empty body; a rejected block is never published
            }
            this.lastForgedSlot = slot;
            this.forged++;
            this.writeState(slot);
            if (attempt.included.length) await this.node.dropFromMempool(attempt.included.map((t) => t.hash)).catch(() => undefined);
            logger.info(`Block producer: forged block ${blockNumber} at slot ${slot} (${attempt.included.length} tx, ${forged.blockFetchBytes.length} bytes) hash ${Buffer.from(forged.headerHash).toString("hex").slice(0, 16)}… KES evolution ${forged.kesEvolution}`);
            return;
        }
    }

    private readState(): bigint | null {
        const f = this.cfg.stateFile;
        if (!f || !existsSync(f)) return null;
        try { const j = JSON.parse(readFileSync(f, "utf8")); return j.lastForgedSlot != null ? BigInt(j.lastForgedSlot) : null; } catch { return null; }
    }

    private writeState(slot: bigint): void {
        const f = this.cfg.stateFile;
        if (!f) return;
        try { writeFileSync(f, JSON.stringify({ poolId: this.poolId, lastForgedSlot: slot.toString(), at: new Date().toISOString() }) + "\n"); } catch (err) { logger.warn("Block producer: could not persist state:", err); }
    }
}

/** Production node adapter: DB + orchestrator + shared mempool + schedule worker. */
export function nodeAdapter(opts: {
    network: EpochNetwork; era: number; genesis: ShelleyGenesisLike;
    nonceFor: (epoch: number) => Promise<string | null>;
    adopt: (bytes: Uint8Array) => Promise<unknown>;
    mempoolTxs: () => Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>>;
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
        tip: getChainTip,
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
        dropFromMempool: opts.dropFromMempool,
        adopt: async (b) => { await opts.adopt(b); },
        schedule: scheduleInWorker,
    };
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: LeaderSlot[]) => void; reject: (e: Error) => void }>();

/** Run leaderSlotsForEpoch in a dedicated worker; the VRF secret is copied for the call and zeroed there. */
export function scheduleInWorker(input: { epoch: number; nonceHex: string; sigma: { num: bigint; den: bigint }; vrf: VrfKey; network?: EpochNetwork; activeSlotsCoeff?: number }): Promise<LeaderSlot[]> {
    if (!worker) {
        worker = new Worker(new URL("./scheduleWorker.ts", import.meta.url).href);
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
