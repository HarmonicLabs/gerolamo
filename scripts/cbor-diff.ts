/**
 * Structural diff of two CBOR items (for answers too big to eyeball: DebugNewEpochState,
 * DebugEpochState, GetGovState): walks both in step — arrays by index, maps by key — and prints, per
 * field path, whether the bytes agree, and for maps how many keys are missing, extra or carry a
 * different value, with an example of each. Map entries are aggregated under `[*]`, so a field that
 * differs in 300 accounts is one line. Field names come from a schema for the ledger states.
 *   bun scripts/cbor-diff.ts <ours.cbor> <ref.cbor> [--schema nes|es] [--unwrap] [--depth 12]
 * `--unwrap` drops a LocalStateQuery `Right` wrapper (0x81) from both; scripts/n2c-compare.ts --save writes such files.
 */
import { readFileSync } from "node:fs";

type S = { name?: string; fields?: Array<S | string>; values?: S };
const arr = (...fields: Array<S | string>): S => ({ fields });
const named = (name: string, s: S): S => ({ ...s, name });
const mapOf = (values: S): S => ({ values });
const snapshot = arr(named("activeStake", mapOf(arr("stake", "pool"))), named("pools", mapOf(arr("stake", "ratio", "owners", "ownerStake", "vrf", "pledge", "cost", "margin", "delegators", "account"))));
const govState = arr(named("proposals", arr("roots", "actions")), "committee", "constitution", "curPParams", "prevPParams", "futurePParams", named("pulsing", arr(named("snapshot", arr("proposals", "drepDistr", "drepState", "poolDistr")), named("ratifyState", arr("enactState", "enacted", "expired", "delayed")))));
const epochState = arr(
    named("account", arr("treasury", "reserves")),
    named("ledger", arr(
        named("cert", arr(
            named("vstate", arr(named("dreps", mapOf(arr("expiry", "anchor", "deposit", "delegators"))), "committeeState", "dormant")),
            named("pstate", arr("vrfKeyHashes", named("pools", mapOf(arr("vrf", "pledge", "cost", "margin", "account", "owners", "relays", "metadata", "deposit", "delegators"))), "future", "retiring")),
            named("dstate", arr(named("accounts", mapOf(arr("balance", "deposit", "pool", "drep"))), "futureGenDelegs", "genDelegs", "irwd")),
        )),
        named("utxoState", arr("utxo", "deposited", "fees", named("govState", govState), "instantStake", "donation")),
    )),
    named("snapshots", arr(named("mark", snapshot), named("set", snapshot), named("go", snapshot), "fee")),
    named("nonMyopic", arr("likelihoods", "rewardPot")),
);
const SCHEMAS: Record<string, S> = { nes: arr("epoch", "blocksPrev", "blocksCur", named("epochState", epochState), "rewardUpdate", "poolDistr", "stashedAVVM"), es: epochState, gov: govState };

// ---------------------------------------------------------------- raw CBOR
function head(b: Uint8Array, o: number) { const ib = b[o]!, mt = ib >> 5, ai = ib & 31; let p = o + 1, n = 0; if (ai < 24) n = ai; else if (ai <= 27) { const w = 1 << (ai - 24); for (let i = 0; i < w; i++) n = n * 256 + b[p + i]!; p += w; } else if (ai === 31) return { mt, n: -1, p, indef: true }; return { mt, n, p, indef: false }; }
function end(b: Uint8Array, o: number): number { const h = head(b, o); if (h.indef) { let p = h.p; if (h.mt === 7) return p; while (b[p] !== 0xff) p = end(b, p); return p + 1; } switch (h.mt) { case 0: case 1: case 7: return h.p; case 2: case 3: return h.p + h.n; case 4: { let p = h.p; for (let i = 0; i < h.n; i++) p = end(b, p); return p; } case 5: { let p = h.p; for (let i = 0; i < 2 * h.n; i++) p = end(b, p); return p; } default: return end(b, h.p); } }
function children(b: Uint8Array, o: number): number[] { const h = head(b, o); if (h.mt === 6) return [h.p]; if (h.mt !== 4 && h.mt !== 5) return []; const out: number[] = [], cnt = h.indef ? Infinity : h.mt === 5 ? 2 * h.n : h.n; let p = h.p; for (let i = 0; i < cnt; i++) { if (h.indef && b[p] === 0xff) break; out.push(p); p = end(b, p); } return out; }
const hexAt = (b: Uint8Array, o: number, max = 48) => { const e = end(b, o); const s = Buffer.from(b.subarray(o, Math.min(e, o + max))).toString("hex"); return e - o > max ? `${s}… (${e - o} B)` : s; };

interface Stat { same: number; diff: number; missing: number; extra: number; example?: string; headDiff?: string }
const stats = new Map<string, Stat>();
const stat = (p: string) => { let s = stats.get(p); if (!s) stats.set(p, (s = { same: 0, diff: 0, missing: 0, extra: 0 })); return s; };

function cmp(a: Uint8Array, oa: number, b: Uint8Array, ob: number, path: string, s: S | undefined, depth: number, maxDepth: number): void {
    const ea = end(a, oa), eb = end(b, ob);
    const st = stat(path);
    if (ea - oa === eb - ob && Buffer.compare(Buffer.from(a.buffer, a.byteOffset + oa, ea - oa), Buffer.from(b.buffer, b.byteOffset + ob, eb - ob)) === 0) { st.same++; return; }
    st.diff++;
    const ha = head(a, oa), hb = head(b, ob);
    if (depth >= maxDepth || ha.mt !== hb.mt || (ha.mt !== 4 && ha.mt !== 5 && ha.mt !== 6)) { st.example ??= `ours ${hexAt(a, oa)} ref ${hexAt(b, ob)}`; return; }
    if (ha.mt === 6) { cmp(a, children(a, oa)[0]!, b, children(b, ob)[0]!, path, s, depth + 1, maxDepth); return; }
    if (a[oa] !== b[ob]) st.headDiff ??= `head ours ${a[oa]!.toString(16)} ref ${b[ob]!.toString(16)}`;
    if (ha.mt === 4) {
        const ca = children(a, oa), cb = children(b, ob);
        if (ca.length !== cb.length) st.example ??= `lengths ours ${ca.length} ref ${cb.length}`;
        for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
            const f = s?.fields?.[i];
            const name = typeof f === "string" ? f : f?.name ?? (s?.values ? "[*]" : String(i));
            cmp(a, ca[i]!, b, cb[i]!, `${path}.${name}`, typeof f === "string" ? undefined : f ?? (s?.values), depth + 1, maxDepth);
        }
        return;
    }
    // maps: by key bytes
    const ca = children(a, oa), cb = children(b, ob);
    const ka = new Map<string, number>(), kb = new Map<string, number>();
    for (let i = 0; i < ca.length; i += 2) ka.set(Buffer.from(a.subarray(ca[i]!, end(a, ca[i]!))).toString("hex"), ca[i + 1]!);
    for (let i = 0; i < cb.length; i += 2) kb.set(Buffer.from(b.subarray(cb[i]!, end(b, cb[i]!))).toString("hex"), cb[i + 1]!);
    const vp = `${path}[*]`;
    for (const [k, vo] of ka) { const r = kb.get(k); if (r == null) { const x = stat(vp); x.extra++; x.example ??= `extra key ${k.slice(0, 64)}`; continue; } cmp(a, vo, b, r, vp, s?.values, depth + 1, maxDepth); }
    for (const k of kb.keys()) if (!ka.has(k)) { const x = stat(vp); x.missing++; x.example ??= `missing key ${k.slice(0, 64)}`; }
    // the keys agree but the order or the head does not
    if ([...ka.keys()].join() !== [...kb.keys()].join() && ka.size === kb.size && [...ka.keys()].every((k) => kb.has(k))) st.example ??= "same keys, different order";
}

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1]! : d; };
const [fa, fb] = args.filter((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--schema") && !args[i - 1]?.startsWith("--depth"));
let a = new Uint8Array(readFileSync(fa!)), b = new Uint8Array(readFileSync(fb!));
if (flag("unwrap")) { if (a[0] === 0x81) a = a.subarray(1); if (b[0] === 0x81) b = b.subarray(1); }
const schema = SCHEMAS[opt("schema", "nes")];
cmp(a, 0, b, 0, "root", schema, 0, Number(opt("depth", "12")));
console.log(`ours ${a.length} B, ref ${b.length} B`);
const rows = [...stats.entries()].filter(([, s]) => s.diff || s.missing || s.extra).sort((x, y) => (x[0] < y[0] ? -1 : 1));
for (const [p, s] of rows) {
    const leaf = !rows.some(([q]) => q !== p && q.startsWith(p + ".") || q.startsWith(p + "[*]"));
    console.log(`${leaf ? "DIFF" : "    "} ${p}: ${s.diff} differ${s.same ? `, ${s.same} same` : ""}${s.missing ? `, ${s.missing} missing` : ""}${s.extra ? `, ${s.extra} extra` : ""}${s.headDiff ? `; ${s.headDiff}` : ""}${s.example ? `; e.g. ${s.example}` : ""}`);
}
if (!rows.length) console.log("identical");
