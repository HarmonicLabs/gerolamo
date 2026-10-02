/**
 * Offline replay of the Byron update interface (src/consensus/byron/ByronUpdate.ts) over a
 * cardano-node immutable directory, read-only. Drives the tracker exactly like
 * `Block.Validation.updateBlock`: epoch transition, then proposal → votes → endorsement per
 * main block; the delegation map comes from ByronObftState (genesis heavyDelegation plus
 * on-chain certificates, 2k-slot activation), taken *before* the block like `updateBody` does.
 *
 *   bun scripts/byron-update-replay.ts <immutable dir> --genesis src/config/mainnet/byron-genesis.json
 *       [--k 2160] [--to-slot N] [--quiet] [--no-sigs]
 *
 * Stops at the first non-Byron block. Exit 1 when any block fails a rule (on a real chain every
 * failure is a false rejection by our code).
 *
 * This follows the CHAIN rule (`updateBlock`). The node follows ouroboros-consensus instead
 * (`applyChainTick` ticks the delegation state too, an EBB moves `cvsLastSlot`): that path, with
 * the size limits, the delegation rules, the transition epoch and the UTxO rules on the adopted
 * parameters, is scripts/byron-ledger-replay.ts (bug 296).
 */
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { ChunkStore } from "../src/storage/chunkStore";
import { splitEraBlock } from "../src/consensus/bodyHash";
import { ByronObftState } from "../src/consensus/byron/ByronOBFT";
import { byronKeyHash, sliceByronMainHeader } from "../src/consensus/byron/ByronCrypto";
import { ByronUpdateTracker, pvKey, type ByronUpdateEvent } from "../src/consensus/byron/ByronUpdate";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const genesisFile = opt("genesis");
if (!dir || !genesisFile) {
    console.error("usage: bun scripts/byron-update-replay.ts <immutable dir> --genesis <byron-genesis.json> [--k N] [--to-slot N] [--quiet] [--no-sigs]");
    process.exit(2);
}
const genesis = await Bun.file(genesisFile).json();
const k = Number(opt("k") ?? genesis.protocolConsts.k);
const quiet = argv.includes("--quiet");
const toSlot = Number(opt("to-slot") ?? Number.MAX_SAFE_INTEGER);
const tracker = ByronUpdateTracker.fromGenesis(genesis, { k, skipSignatures: argv.includes("--no-sigs") });
const obft = new ByronObftState(genesis, { k });
const store = await ChunkStore.open(dir, { chunkSlots: 10 * k, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const khMemo = new Map<string, string>();
const kh = (x: Uint8Array) => { const h = Buffer.from(x).toString("hex"); let v = khMemo.get(h); if (!v) khMemo.set(h, (v = byronKeyHash(x))); return v; };
const short = (s: string) => s.slice(0, 12);

function show(e: ByronUpdateEvent): string {
    switch (e.type) {
        case "adopted": return `ADOPTED pv ${pvKey(e.protocolVersion)} at epoch ${e.epoch} (slot ${e.slot}); params changed: ${e.changed.join(", ") || "none"}`;
        case "proposal": return `proposal ${short(e.upId)} pv ${pvKey(e.protocolVersion)} sv ${e.softwareVersion.appName}:${e.softwareVersion.number} ppu {${e.ppUpdate.join(",")}}`;
        case "vote": return `  vote ${short(e.upId)} by ${short(e.voter)}`;
        case "confirmed": return `confirmed ${short(e.upId)}`;
        case "candidate": return `candidate pv ${pvKey(e.protocolVersion)}`;
        case "expired": return `expired ${short(e.upId)}`;
        case "app-version": return `app version ${e.appName} → ${e.version}`;
        case "error": return `ERROR ${e.error}`;
    }
}

const t0 = performance.now();
let mains = 0, ebbs = 0, lastSlot = 0;
const errors: string[] = [];
for await (const b of store.iterate(0, toSlot, { includeEbb: true })) {
    const { era, rawBlock } = splitEraBlock(b.bytes);
    if (era > 1) {
        console.log(`first non-Byron block (era tag ${era}) at slot ${b.slot}: stop`);
        // The HFC boundary: tick the Byron ledger to the first post-Byron slot.
        for (const e of tracker.tick(BigInt(b.slot))) console.log(`[tick ${b.slot}] ${show(e)}`);
        break;
    }
    if (era === 0) { ebbs++; continue; }
    const blk = Cbor.parseLazy(rawBlock);
    if (!(blk instanceof LazyCborArray) || blk.array.length < 2) { errors.push(`slot ${b.slot}: malformed block`); continue; }
    const [rawHeader, rawBody] = [blk.array[0]!, blk.array[1]!];
    const dm = obft.delegationMap();
    const events = tracker.applyRawMainBlock(rawHeader, rawBody, dm);
    for (const e of events) {
        if (e.type === "error") errors.push(`slot ${e.slot}: ${e.error}`);
        if (!quiet || e.type === "adopted" || e.type === "error" || e.type === "proposal" || e.type === "confirmed" || e.type === "candidate") {
            console.log(`[slot ${e.slot}] ${show(e)}`);
        }
    }
    const s = sliceByronMainHeader(rawHeader);
    const issuerKh = kh(s.blockSig.cert ? s.blockSig.cert.issuerXPub : s.headerPubKey);
    const signerKh = kh(s.blockSig.cert ? s.blockSig.cert.delegateXPub : s.headerPubKey);
    obft.validateSignedMainHeader(BigInt(b.slot), issuerKh, signerKh); // activates due delegations
    obft.noteAppliedIssuer(issuerKh, BigInt(b.slot), rawBody);
    mains++;
    lastSlot = b.slot;
    if (mains % 250_000 === 0) console.log(`  … ${mains} main blocks, slot ${b.slot}, ${((performance.now() - t0) / 1000).toFixed(0)} s, adopted ${pvKey(tracker.adoptedProtocolVersion())}`);
}

const st = tracker.state;
const pp = st.adoptedProtocolParameters;
console.log(`\n${mains} main blocks + ${ebbs} EBBs to slot ${lastSlot} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`counters: ${JSON.stringify(tracker.counters)}`);
console.log(`adopted protocol version: ${pvKey(st.adoptedProtocolVersion)}`);
console.log(`adopted parameters: ${JSON.stringify(pp, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(`candidates: ${st.candidateProtocolUpdates.map((c) => `${pvKey(c.protocolVersion)}@${c.slot}`).join(", ") || "none"}`);
console.log(`registered: ${st.registeredProtocolUpdateProposals.size} protocol, ${st.registeredSoftwareUpdateProposals.size} software; confirmed ${st.confirmedProposals.size}`);
console.log(`app versions: ${[...st.appVersions].map(([n, a]) => `${n}:${a.version}@${a.slot}`).join(", ") || "none"}`);
if (errors.length) {
    console.log(`FAIL: ${errors.length} rule failure(s):`);
    for (const e of errors.slice(0, 50)) console.log("  " + e);
    process.exit(1);
}
console.log("OK: no rule failures");
process.exit(0);
