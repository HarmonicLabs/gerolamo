import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { initSql } from "../sql";
import { ensureInitialized, setStrictUtxoApply } from "../db";
import { configureBlockStoreMode, setNodeBlockStore } from "../storage/nodeBlockStore";
import { ConsensusOrchestrator } from "./ConsensusOrchestratooor";
import { GENESIS, growChain, incoming } from "./chainsel/sim";

/**
 * ChainSync Jumping wired into the orchestrator (Genesis mode): the governor's instructions reach the
 * peers' connections — the dynamo streams, a jumper is paused and answers single-point jumps, the
 * jumper that takes over from an idle dynamo is positioned at its last jump, resumes and becomes the
 * primary.
 */
const dir = mkdtempSync(join(tmpdir(), "gerolamo-csj-loop-"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class FakePeer {
    paused = false;
    readonly jumps: string[] = [];
    readonly restarts: string[] = [];
    chainSyncGeneration = 1;
    chainSyncInFlight = 0;
    isTerminated = false;
    readonly source = "ledger";
    readonly chainSyncAtTip = false;
    constructor(readonly peerKey: string, private readonly answer: (hash: string) => boolean) {}
    get peerId(): string { return `${this.peerKey}:1`; }
    pauseChainSync(): void { this.paused = true; }
    resumeChainSync(): void { this.paused = false; }
    async csjJump(p: ChainPoint): Promise<boolean> { const h = hex(p.blockHeader!.hash); this.jumps.push(h); return this.answer(h); }
    async restartChainSync(reason: string): Promise<void> { this.restarts.push(reason); }
    terminate(): void { this.isTerminated = true; }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); }
}

let orch: ConsensusOrchestrator;
beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    configureBlockStoreMode("mirror");
    setNodeBlockStore(null);
});
afterAll(async () => {
    await orch?.stop().catch(() => undefined);
    setStrictUtxoApply(false); // the orchestrator sets this process-wide
    configureBlockStoreMode("primary");
    rmSync(dir, { recursive: true, force: true });
});

describe("ChainSync Jumping in the orchestrator (Genesis mode)", () => {
    test("dynamo streams, jumper pauses and jumps; an idle dynamo hands over to the jumper, which becomes primary", async () => {
        const chain = growChain(GENESIS, 40, { tag: "c", gap: 20 });
        const onChain = new Set(chain.map((h) => h.hash));
        const peers = new Map<string, FakePeer>([
            ["10.0.0.1:3001", new FakePeer("10.0.0.1:3001", (h) => onChain.has(h))],
            ["10.0.0.2:3001", new FakePeer("10.0.0.2:3001", (h) => onChain.has(h))],
        ]);
        orch = new ConsensusOrchestrator({
            networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", syncFromGenesis: true,
            dbPath: join(dir, "t.db"), validation: { workers: 0 }, consensus: { mode: "genesis", csjJumpSize: 200 },
        } as never, {
            getPeer: (id: string) => peers.get(id) ?? [...peers.values()].find((p) => p.peerId === id) ?? null,
            pickHotPeer: () => null,
        } as never);
        const o = orch as any;
        await o.chainSel.syncOurs();
        const [dyn, jumper] = [...peers.values()];
        orch.registerHotPeer(dyn!.peerKey);
        orch.registerHotPeer(jumper!.peerKey);
        expect(o.chainSel.csj.dynamo()).toBe(dyn!.peerKey);
        await until(() => jumper!.paused); // a jumper downloads no headers
        expect(dyn!.paused).toBe(false);

        // the dynamo's headers pass the 200-slot jump boundary: the jumper is asked to jump to its validated head
        await o.chainSel.observe(dyn!.peerKey, chain.slice(0, 15).map(incoming));
        await until(() => jumper!.jumps.length > 0);
        expect(onChain.has(jumper!.jumps[0]!)).toBe(true);
        await until(() => o.chainSel.cs.fragmentOf(jumper!.peerKey)?.headers.length > 0);
        expect(o.chainSel.cs.fragmentOf(jumper!.peerKey).headers.at(-1).hash).toBe(jumper!.jumps[0]);

        // MsgAwaitReply from the dynamo: disengaged; the jumper is positioned at its last jump, resumes and drives
        orch.handleAwaitReply(dyn!.peerId);
        await until(() => !jumper!.paused && jumper!.jumps.length >= 2);
        expect(o.chainSel.csj.dynamo()).toBe(jumper!.peerKey);
        expect(orch.primaryPeerKey()).toBe(jumper!.peerKey);
        expect(o.chainSel.csj.stateOf(dyn!.peerKey).kind).toBe("disengaged");
        expect(dyn!.paused).toBe(false); // a disengaged peer runs normal ChainSync
    }, 30_000);
});
