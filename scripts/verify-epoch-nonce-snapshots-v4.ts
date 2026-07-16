/**
 * Ad-hoc v4: continuous UPDN+TICKN from Shelley hard fork vs external nonces.
 *
 * Critical Haskell facts (cardano-ledger TPraos):
 *   ⋆ = blake2b_256(x || y) ; NeutralNonce is identity
 *   bnonce = mkNonceFromOutputVRF(certifiedOutput) = blake2b_256(64-byte VRF output)
 *   hashHeaderToNonce h = castHash h  (raw 32-byte header hash as Nonce)
 *
 *   UPDN per block (continuous forever — ηv/ηc NEVER reset to η0):
 *     ηv' = ηv ⋆ bnonce
 *     ηc' = ηv' if s + StabilityWindow < firstSlotNextEpoch else ηc
 *
 *   TICKN only updates TicknState (η0, ηh), NOT PrtclState (ηv, ηc):
 *     η0' = ηc ⋆ ηh ⋆ ηe
 *     ηh' = csLabNonce at boundary
 *
 *   initialChainDepState:
 *     ηv = ηc = initNonce
 *     TicknState (initNonce, NeutralNonce)  → first Shelley epoch η0 = initNonce
 *     csLabNonce = NeutralNonce
 *
 *   So external η0 of first Shelley epoch (4 on preprod) IS the initNonce.
 *
 * Usage:
 *   bun scripts/verify-epoch-nonce-snapshots-v4.ts --epochs 4,5,6
 *   bun scripts/verify-epoch-nonce-snapshots-v4.ts --epochs 4,5,6 --persist
 *
 * Not suite green — research verification.
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256, sha2_256_sync } from "@harmoniclabs/crypto";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { parseChunk } from "../src/state/legacy.ts";
import {
    seedCombine,
    stabilityWindowSlots,
} from "../src/utils/calcEpochNonce.ts";
import {
    getFirstSlotOfEpoch,
    calculatePreProdCardanoEpoch,
} from "../src/utils/epochFromSlotCalculations.ts";
import genesis from "../src/config/preprod/shelley-genesis.json";
import { resolve } from "node:path";

const IMMUTABLE = resolve(
    import.meta.dir,
    "../snapshots/preprod/db/immutable",
);
const EXTERNAL_BASE = "https://blockfrost-preprod.onchainapps.io";

const securityParam = Number((genesis as any).securityParam ?? 2160);
const activeSlotsCoeff = Number((genesis as any).activeSlotsCoeff ?? 0.05);
const STABILITY = stabilityWindowSlots(securityParam, activeSlotsCoeff);

type NonceExtractMode = "blake2b_proofHash" | "sha2_proofHash" | "raw_proofHash";

function parseArgs(): {
    epochs: number[];
    persist: boolean;
    mode: NonceExtractMode;
} {
    const a = process.argv.slice(2);
    let epochs = [4, 5, 6];
    let persist = false;
    let mode: NonceExtractMode = "blake2b_proofHash";
    for (let i = 0; i < a.length; i++) {
        if (a[i] === "--epochs" && a[i + 1]) {
            epochs = a[++i].split(",").map((x) => Number(x.trim()));
        }
        if (a[i] === "--persist") persist = true;
        if (a[i] === "--mode" && a[i + 1]) {
            mode = a[++i] as NonceExtractMode;
        }
    }
    return { epochs, persist, mode };
}

async function fetchExternalNonce(epoch: number): Promise<string> {
    const url = `${EXTERNAL_BASE}/epochs/${epoch}/parameters`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch epoch ${epoch}: ${r.status}`);
    const j: any = await r.json();
    if (!j?.nonce || typeof j.nonce !== "string") {
        throw new Error(`no nonce for epoch ${epoch}`);
    }
    return j.nonce as string;
}

async function loadChunk(n: number) {
    const p = n.toString().padStart(5, "0");
    const [pb, sb, cb] = await Promise.all([
        Bun.file(`${IMMUTABLE}/${p}.primary`).arrayBuffer(),
        Bun.file(`${IMMUTABLE}/${p}.secondary`).arrayBuffer(),
        Bun.file(`${IMMUTABLE}/${p}.chunk`).arrayBuffer(),
    ]);
    return parseChunk(new DataView(pb), new DataView(sb), new DataView(cb));
}

function chunkForSlot(slot: bigint): number {
    return Math.max(0, Math.floor(Number(slot) / 21600));
}

type BlockInfo = {
    slot: bigint;
    era: number;
    headerHash: Uint8Array;
    /** prev header hash from body (for csLabNonce variants) */
    prevHash: Uint8Array | null;
    blockNonce: Uint8Array;
};

function extractBlockNonce(
    meb: MultiEraBlock,
    mode: NonceExtractMode,
): Uint8Array | null {
    const header = meb.block.header as any;
    const body = header?.body ?? header;
    if (!body) return null;

    let proofHash: Uint8Array | null = null;
    if (body.nonceVrfResult?.proofHash) {
        proofHash = body.nonceVrfResult.proofHash as Uint8Array;
    } else if (body.vrfResult?.proofHash) {
        proofHash = body.vrfResult.proofHash as Uint8Array;
    }
    if (!proofHash) return null;

    switch (mode) {
        case "blake2b_proofHash":
            return blake2b_256(proofHash);
        case "sha2_proofHash":
            return sha2_256_sync(proofHash);
        case "raw_proofHash":
            // only valid if proofHash is already 32 bytes (it is 64 on preprod)
            return proofHash.length === 32
                ? proofHash
                : blake2b_256(proofHash);
        default:
            return blake2b_256(proofHash);
    }
}

async function collectBlocksInRange(
    slotStart: bigint,
    slotEnd: bigint,
    mode: NonceExtractMode,
): Promise<BlockInfo[]> {
    const firstChunk = Math.max(0, chunkForSlot(slotStart) - 1);
    const lastChunk = chunkForSlot(slotEnd) + 2;
    const out: BlockInfo[] = [];
    for (let c = firstChunk; c <= lastChunk; c++) {
        let blocks;
        try {
            blocks = await loadChunk(c);
        } catch {
            continue;
        }
        for (const b of blocks) {
            if (b.slotNo < slotStart || b.slotNo > slotEnd) continue;
            try {
                const meb = MultiEraBlock.fromCbor(b.blockCbor);
                if (meb.era < 2) continue;
                const header = meb.block.header as any;
                const body = header.body ?? header;
                const headerHash =
                    b.headerHash?.length === 32
                        ? b.headerHash
                        : blake2b_256(header.toCborBytes());
                const blockNonce = extractBlockNonce(meb, mode);
                if (!blockNonce) continue;
                let prevHash: Uint8Array | null = null;
                if (body?.prevHash instanceof Uint8Array) {
                    prevHash = body.prevHash;
                }
                out.push({
                    slot: b.slotNo,
                    era: meb.era,
                    headerHash,
                    prevHash,
                    blockNonce,
                });
            } catch {
                // skip
            }
        }
    }
    out.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    return out;
}

type TicknResult = {
    epoch: number; // epoch whose η0 we just computed (the NEW epoch)
    eta0: string;
    etaC: string;
    etaV: string;
    etaH: string;
    nBlocksPrev: number;
    nBeforeFreeze: number;
};

/**
 * Continuous sim:
 * - ηv/ηc evolve through all blocks, never reset to η0
 * - At each epoch boundary, TICKN produces η0 for next epoch
 * - ηh starts NeutralNonce; after each TICKN becomes labNonce from last block of ended epoch
 *
 * labNonceMode:
 *   - 'lastHeader' : hash of last block of ended epoch (formal comment)
 *   - 'prevOfLast' : prevHash of last block (= csLabNonce after last apply in API)
 *   - 'neutral'    : always Neutral (diagnostic)
 */
function simulateContinuous(
    blocks: BlockInfo[],
    initNonce: Uint8Array,
    firstEpoch: number,
    lastEpoch: number,
    labNonceMode: "lastHeader" | "prevOfLast" | "neutral",
    reEqualize: boolean,
): TicknResult[] {
    let etaV = new Uint8Array(initNonce);
    let etaC = new Uint8Array(initNonce);
    // ticknStatePrevHashNonce starts NeutralNonce
    let etaH: Uint8Array | null = null; // null = NeutralNonce
    const results: TicknResult[] = [];

    // First Shelley epoch η0 = initNonce (initial TicknState)
    results.push({
        epoch: firstEpoch,
        eta0: toHex(initNonce),
        etaC: toHex(initNonce),
        etaV: toHex(initNonce),
        etaH: "(init)",
        nBlocksPrev: 0,
        nBeforeFreeze: 0,
    });

    for (let e = firstEpoch; e <= lastEpoch; e++) {
        const first = BigInt(getFirstSlotOfEpoch(e, genesis as any));
        const firstNext = BigInt(getFirstSlotOfEpoch(e + 1, genesis as any));
        const epochBlocks = blocks.filter(
            (b) => b.slot >= first && b.slot < firstNext,
        );
        if (epochBlocks.length === 0) continue;

        let nBeforeFreeze = 0;
        for (const b of epochBlocks) {
            // UPDN: s + StabilityWindow < firstSlotNext
            const beforeFreeze = b.slot + BigInt(STABILITY) < firstNext;
            etaV = seedCombine(etaV, b.blockNonce);
            if (beforeFreeze) {
                etaC = new Uint8Array(etaV);
                nBeforeFreeze++;
            }
        }

        const last = epochBlocks[epochBlocks.length - 1];

        // TICKN for epoch e+1
        let eta0: Uint8Array;
        if (etaH === null || etaH.length === 0) {
            eta0 = new Uint8Array(etaC); // ⋆ NeutralNonce = identity
        } else {
            eta0 = seedCombine(etaC, etaH);
        }
        // extraEntropy Neutral → identity

        let labForNext: Uint8Array | null;
        if (labNonceMode === "neutral") {
            labForNext = null;
        } else if (labNonceMode === "prevOfLast") {
            labForNext = last.prevHash;
        } else {
            labForNext = last.headerHash;
        }

        results.push({
            epoch: e + 1,
            eta0: toHex(eta0),
            etaC: toHex(etaC),
            etaV: toHex(etaV),
            etaH: etaH ? toHex(etaH) : "(NeutralNonce)",
            nBlocksPrev: epochBlocks.length,
            nBeforeFreeze,
        });

        // Update ηh for next boundary
        etaH = labForNext;

        // ONLY if reEqualize (wrong but diagnostic): reset ηv/ηc to η0
        if (reEqualize) {
            etaV = new Uint8Array(eta0);
            etaC = new Uint8Array(eta0);
        }
    }

    return results;
}

async function maybePersist(
    matches: { epoch: number; nonce: string }[],
): Promise<void> {
    if (!matches.length) return;
    // Dynamic import so script works without a live DB path if not persisting
    const { initDb, storeEpochNonce, getEpochNonce } = await import(
        "../src/db.ts"
    );
    await initDb();
    for (const m of matches) {
        await storeEpochNonce(m.epoch, m.nonce, "local");
        const check = await getEpochNonce(m.epoch);
        console.log(
            `[DB] storeEpochNonce(${m.epoch}, local) → readback ${check === m.nonce ? "OK" : "FAIL"} ${check?.slice(0, 16)}…`,
        );
    }
}

async function main() {
    const { epochs, persist, mode } = parseArgs();
    const firstEpoch = Math.min(...epochs);
    const lastEpoch = Math.max(...epochs);

    console.log("=== Snapshot epoch-nonce verification v4 (continuous) ===\n");
    console.log("immutable:", IMMUTABLE);
    console.log("stabilityWindow:", STABILITY);
    console.log("blockNonce mode:", mode);
    console.log("ηv/ηc: continuous (no re-eq to η0) — plus re-eq diagnostic");
    console.log("epochs:", firstEpoch, "→", lastEpoch + 1);
    console.log("");

    // External nonces
    const external = new Map<number, string>();
    for (let e = firstEpoch; e <= lastEpoch + 1; e++) {
        try {
            const n = await fetchExternalNonce(e);
            external.set(e, n);
            console.log(`[external] epoch ${e} η0 = ${n}`);
        } catch (err) {
            console.log(`[external] epoch ${e} FAIL: ${err}`);
        }
    }
    console.log("");

    const extInit = external.get(firstEpoch);
    if (!extInit) {
        console.error("Need external η0 for first Shelley epoch as initNonce");
        process.exit(1);
    }

    const slotStart = BigInt(getFirstSlotOfEpoch(firstEpoch, genesis as any));
    // include a few slots before for safety (first shelley block is 86400, first slot 86409)
    const collectStart = slotStart > 20n ? slotStart - 20n : 0n;
    const slotEnd =
        BigInt(getFirstSlotOfEpoch(lastEpoch + 1, genesis as any)) - 1n;

    console.log(`Collecting blocks [${collectStart}, ${slotEnd}] mode=${mode}…`);
    const blocks = await collectBlocksInRange(collectStart, slotEnd, mode);
    console.log(
        `blocks=${blocks.length} first=${blocks[0]?.slot} last=${blocks[blocks.length - 1]?.slot}`,
    );
    if (!blocks.length) {
        console.error("no blocks");
        process.exit(1);
    }
    console.log(`sample bnonce[0]=${toHex(blocks[0].blockNonce)}`);
    console.log("");

    type Config = {
        name: string;
        init: Uint8Array;
        lab: "lastHeader" | "prevOfLast" | "neutral";
        reEq: boolean;
    };

    const configs: Config[] = [
        {
            name: "init=η0_E4 continuous lastHeader",
            init: fromHex(extInit),
            lab: "lastHeader",
            reEq: false,
        },
        {
            name: "init=η0_E4 continuous prevOfLast",
            init: fromHex(extInit),
            lab: "prevOfLast",
            reEq: false,
        },
        {
            name: "init=η0_E4 continuous neutral-ηh",
            init: fromHex(extInit),
            lab: "neutral",
            reEq: false,
        },
        {
            name: "init=η0_E4 reEq lastHeader",
            init: fromHex(extInit),
            lab: "lastHeader",
            reEq: true,
        },
        {
            name: "init=mkNonce(0) continuous lastHeader",
            init: (() => {
                const buf = new Uint8Array(8);
                return blake2b_256(buf);
            })(),
            lab: "lastHeader",
            reEq: false,
        },
        {
            name: "init=zeros continuous lastHeader",
            init: new Uint8Array(32),
            lab: "lastHeader",
            reEq: false,
        },
    ];

    let best: {
        name: string;
        matches: number;
        results: TicknResult[];
    } | null = null;

    for (const cfg of configs) {
        const results = simulateContinuous(
            blocks,
            cfg.init,
            firstEpoch,
            lastEpoch,
            cfg.lab,
            cfg.reEq,
        );
        let matchCount = 0;
        console.log(`--- ${cfg.name} ---`);
        for (const r of results) {
            const ext = external.get(r.epoch);
            const match = !!ext && r.eta0 === ext;
            if (match) matchCount++;
            // Only report epochs we care about (first + transitions)
            if (r.epoch >= firstEpoch && r.epoch <= lastEpoch + 1) {
                console.log(
                    `  η0_${r.epoch}: ${match ? "MATCH" : "MISMATCH"}` +
                        `  blocks=${r.nBlocksPrev} freeze=${r.nBeforeFreeze}` +
                        `  ηh=${r.etaH.slice(0, 12)}…`,
                );
                console.log(`    computed=${r.eta0}`);
                console.log(`    external=${ext ?? "N/A"}`);
            }
        }
        console.log(`  → ${matchCount} matches\n`);
        if (!best || matchCount > best.matches) {
            best = { name: cfg.name, matches: matchCount, results };
        }
    }

    console.log("=== Summary ===");
    console.log(`Best: ${best?.name} (${best?.matches} matches)`);

    const matchedEpochs: { epoch: number; nonce: string }[] = [];
    if (best) {
        for (const r of best.results) {
            const ext = external.get(r.epoch);
            if (ext && r.eta0 === ext) {
                matchedEpochs.push({ epoch: r.epoch, nonce: r.eta0 });
            }
        }
    }

    if (matchedEpochs.length) {
        console.log(
            `Matched epochs: ${matchedEpochs.map((m) => m.epoch).join(", ")}`,
        );
        if (persist) {
            console.log("Persisting matched nonces to DB…");
            await maybePersist(matchedEpochs);
        } else {
            console.log("(pass --persist to write matched nonces into epoch_nonces)");
        }
        if (best && best.matches >= epochs.length) {
            console.log("[PASS] continuous sim matches external");
            process.exit(0);
        }
        console.log("[PARTIAL] some matches");
        process.exit(2);
    }

    console.log("[FAIL] no strategy matched external η0");
    console.log(
        "Note: first-epoch η0 is initNonce by construction when init=external η0_E4.",
    );
    process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
