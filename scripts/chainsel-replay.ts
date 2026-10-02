/**
 * Replay real fork history through the ouroboros-consensus chain selection (src/consensus/chainsel):
 * read-only over one or more volatile block stores (Gerolamo's and cardano-node's share the
 * format), build the block tree, and for every fork point check that
 *   - selection over all branches picks the branch of the longest chain (the one the node kept);
 *   - for sibling blocks at the same height, what the Praos tie-break (restricted VRF in Conway)
 *     says, and whether that is the block the chain continued from.
 *
 *   bun scripts/chainsel-replay.ts <volatileDir> [<volatileDir> …] [--k 432]
 */
import { VolatileStore, blockNoOf } from "../src/storage/volatileStore";
import { ChainSel, type ChainHeader } from "../src/consensus/chainsel/ChainSel";
import { comparePraos, tieBreakInfoOf, vrfFlavorForEra } from "../src/consensus/tieBreak";

const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--k");
const kIdx = process.argv.indexOf("--k");
const k = kIdx > 0 ? Number(process.argv[kIdx + 1]) : 432;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Node { hash: string; prev: string | null; slot: bigint; blockNo: bigint; hfcEra: number; raw: Uint8Array; children: string[] }
const nodes = new Map<string, Node>();
for (const dir of args) {
    const vs = await VolatileStore.open(dir, { readOnly: true });
    let n = 0;
    for (const b of vs.all()) {
        const h = hex(b.hash);
        if (nodes.has(h)) continue;
        const bn = blockNoOf(b.bytes);
        if (bn == null) continue;
        nodes.set(h, { hash: h, prev: b.prevHash ? hex(b.prevHash) : null, slot: BigInt(b.slot), blockNo: BigInt(bn), hfcEra: Math.max(0, b.eraTag - 1), raw: b.bytes.subarray(b.headerOffset, b.headerOffset + b.headerSize), children: [] });
        n++;
    }
    console.log(`${dir}: ${n} new block(s)`);
}
for (const x of nodes.values()) if (x.prev && nodes.has(x.prev)) nodes.get(x.prev)!.children.push(x.hash);
const tipOf = (h: string): Node => { let best = nodes.get(h)!; for (const c of best.children) { const t = tipOf(c); if (t.blockNo > best.blockNo || (t.blockNo === best.blockNo && t.slot < best.slot)) best = t; } return best; };
const roots = [...nodes.values()].filter((x) => !x.prev || !nodes.has(x.prev));
const root = roots.sort((a, b) => Number(a.slot - b.slot))[0]!;
const canonTip = tipOf(root.hash);
const canon = new Set<string>();
for (let c: Node | undefined = canonTip; c; c = c.prev ? nodes.get(c.prev) : undefined) canon.add(c.hash);
console.log(`${nodes.size} blocks, ${roots.length} root(s); longest chain tip #${canonTip.blockNo}@${canonTip.slot}`);

let forks = 0, ok = 0, tieAgree = 0, tieDisagree = 0, tieNoPref = 0;
for (const x of nodes.values()) {
    if (x.children.length < 2) continue;
    forks++;
    const kids = x.children.map((c) => nodes.get(c)!);
    // selection over the branches, from the fork point
    const cs = new ChainSel({ k, anchor: { hash: x.hash, slot: x.slot, blockNo: x.blockNo, hfcEra: x.hfcEra } });
    const branchOf = (start: Node): Node[] => { const out = [start]; for (let c = start; c.children.length;) { const next = c.children.map((h) => tipOf(h)).sort((a, b) => Number(b.blockNo - a.blockNo))[0]!; const path: Node[] = []; for (let t: Node | undefined = next; t && t.hash !== c.hash; t = t.prev ? nodes.get(t.prev) : undefined) path.unshift(t); out.push(...path); c = path[path.length - 1]!; } return out; };
    kids.forEach((kid, i) => { cs.addPeer(`b${i}`); for (const n of branchOf(kid)) cs.rollForward(`b${i}`, { hash: n.hash, prevHash: n.prev, slot: n.slot, hfcEra: n.hfcEra, raw: n.raw }); });
    const best = cs.select().best;
    const kept = kids.find((c) => canon.has(c.hash));
    const pickedKept = best && kept && best.suffix[0]?.hash === kept.hash;
    if (pickedKept || !kept) ok++;
    // the race itself: siblings at the same height
    const a = kept ?? kids[0]!;
    for (const b of kids) {
        if (b === a) continue;
        const ta = tieBreakInfoOf(a.raw), tb = tieBreakInfoOf(b.raw);
        const flavor = vrfFlavorForEra(Math.max(a.hfcEra, b.hfcEra));
        const r = ta && tb && flavor ? comparePraos(flavor, { ...tb, slot: b.slot }, { ...ta, slot: a.slot }) : null; // ours = the dead sibling, cand = the kept one
        const verdict = !r ? "n/a" : r.switch ? "tie-break prefers the kept block" : r.ord === 0 ? "no preference (restricted VRF / identical)" : "tie-break prefers the dead block";
        const ru = ta && tb ? comparePraos({ restricted: false }, { ...tb, slot: b.slot }, { ...ta, slot: a.slot }) : null;
        const unrestricted = ru && r && (ru.switch !== r.switch || (!ru.switch && !r.switch && ru.ord !== r.ord)) ? ` [pre-Conway unrestricted rule would say: ${ru.switch ? "kept" : ru.ord ? "dead" : "none"}]` : "";
        if (r?.switch) tieAgree++; else if (r && r.ord === 0) tieNoPref++; else if (r) tieDisagree++;
        console.log(`fork at #${x.blockNo}@${x.slot}: kept ${a.hash.slice(0, 12)}…@${a.slot}${kept ? "" : " (?)"} vs ${b.hash.slice(0, 12)}…@${b.slot} (Δslot ${a.slot > b.slot ? a.slot - b.slot : b.slot - a.slot}) — ${verdict}${unrestricted}; selection picked ${best?.suffix[0]?.hash.slice(0, 12) ?? "∅"}… ${pickedKept ? "= kept" : "≠ kept"}`);
    }
}
console.log(`${forks} fork point(s): selection picked the kept (longest) branch in ${ok}; sibling races: tie-break agrees with the network ${tieAgree}, no preference ${tieNoPref}, prefers the dead block ${tieDisagree}`);
process.exit(ok === forks ? 0 : 1);
