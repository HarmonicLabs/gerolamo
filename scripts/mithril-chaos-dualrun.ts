/**
 * Mithril chaos dual-run harness — pure-TS shadow vs WASM (SoT).
 *
 * Strategy (stratified, not pure-random):
 *   1. Always tip (latest cert)
 *   2. Always genesis (walk tip→genesis)
 *   3. Always first predecessor of tip (epoch boundary-ish)
 *   4. Uniform random sample of intermediate chain certs
 *   5. Optional: random certificate hashes from aggregator recent list
 *
 * match = wasmOk && Stages 1–5d. implemented/ok stay false (no cutover).
 *
 * Usage:
 *   bun scripts/mithril-chaos-dualrun.ts
 *   NETWORK=preprod N=32 SEED=42 OUT=/tmp/mithril-chaos.json bun scripts/mithril-chaos-dualrun.ts
 *   WITH_CDB_SIDE=1 bun scripts/mithril-chaos-dualrun.ts
 */
import {
    createAggregatorCertificateFetcher,
    createMithrilClient,
    dualRunCertificateChain,
    fetchGenesisVkey,
    isGenesisCertificate,
    networkConfig,
    pureTsFullChainStagesOk,
    selectSnapshot,
    type DualRunVerifyResult,
    type PureTsVerifyOptions,
} from "../src/mithril/index.ts";

type SampleKind = "tip" | "genesis" | "pred1" | "chain" | "random";

type Row = {
    i: number;
    kind: SampleKind;
    hash: string;
    seType: string | null;
    epoch: number | null;
    isGenesis: boolean;
    wasmOk: boolean;
    match: boolean;
    stagesOk: boolean;
    chainOk: boolean;
    contentHashOk: boolean;
    shapeOk: boolean;
    implemented: boolean;
    ok: boolean;
    nSig: number | null;
    reason?: string;
    ms: number;
};

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seTypeOf(cert: Record<string, unknown> | null | undefined): string | null {
    const se = cert?.signed_entity_type;
    if (!se || typeof se !== "object") return null;
    const keys = Object.keys(se as object);
    return keys[0] ?? null;
}

function epochOf(cert: Record<string, unknown> | null | undefined): number | null {
    return typeof cert?.epoch === "number" ? cert.epoch : null;
}

function nSigOf(pureTs: DualRunVerifyResult["pureTs"]): number | null {
    // Best-effort — dualRun result shape varies by stage path
    const p = pureTs as {
        nSignatures?: number | null;
        cryptoPrep?: { nSignatures?: number; entries?: unknown[] };
        reason?: string;
    };
    if (typeof p.nSignatures === "number") return p.nSignatures;
    if (typeof p.cryptoPrep?.nSignatures === "number") return p.cryptoPrep.nSignatures;
    if (Array.isArray(p.cryptoPrep?.entries)) return p.cryptoPrep.entries.length;
    return null;
}

async function walkCollectHashes(
    tipHash: string,
    fetcher: (h: string) => Promise<Record<string, unknown> | null>,
    maxDepth: number,
): Promise<string[]> {
    const out: string[] = [];
    let h: string | null = tipHash;
    const seen = new Set<string>();
    while (h && out.length < maxDepth && !seen.has(h)) {
        seen.add(h);
        out.push(h);
        const cert = await fetcher(h);
        if (!cert) break;
        if (isGenesisCertificate(cert)) break;
        const prev =
            typeof cert.previous_hash === "string" ? cert.previous_hash : null;
        if (!prev || prev.length === 0) break;
        h = prev;
    }
    return out;
}

function pickStratified(
    chain: string[],
    nExtra: number,
    rng: () => number,
): { hash: string; kind: SampleKind }[] {
    if (chain.length === 0) return [];
    const picks: { hash: string; kind: SampleKind }[] = [];
    const used = new Set<string>();

    const add = (hash: string, kind: SampleKind) => {
        if (!hash || used.has(hash)) return;
        used.add(hash);
        picks.push({ hash, kind });
    };

    // tip = index 0
    add(chain[0]!, "tip");
    // genesis = last
    if (chain.length > 1) add(chain[chain.length - 1]!, "genesis");
    // first predecessor
    if (chain.length > 2) add(chain[1]!, "pred1");

    // mid-chain candidates
    const mids = chain.slice(2, Math.max(2, chain.length - 1));
    // shuffle copy
    const shuffled = [...mids];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    for (const h of shuffled) {
        if (picks.length >= 3 + nExtra) break;
        add(h!, "chain");
    }

    return picks;
}

async function main(): Promise<void> {
    const network = (process.env.NETWORK || "preprod").toLowerCase();
    const nExtra = Math.max(0, parseInt(process.env.N || "24", 10) || 24);
    const seed = parseInt(process.env.SEED || String(Date.now() % 1e9), 10);
    const outPath =
        process.env.OUT ||
        `/tmp/mithril-chaos-dualrun-${network}.json`;
    const maxWalk = Math.max(
        64,
        parseInt(process.env.MAX_WALK || "256", 10) || 256,
    );
    const withCdbSide = process.env.WITH_CDB_SIDE === "1";
    const localImm =
        process.env.LOCAL_IMMUTABLE_DIR || "./snapshots/mithril/immutable";

    const cfg = networkConfig(network);
    const gvk = await fetchGenesisVkey(cfg.genesisVkeyUrl);
    const client = await createMithrilClient({ network });
    const fetcher = createAggregatorCertificateFetcher(cfg.aggregator);
    const rng = mulberry32(seed);

    console.log(
        JSON.stringify({
            phase: "start",
            network,
            aggregator: cfg.aggregator,
            nExtra,
            seed,
            maxWalk,
            withCdbSide,
            outPath,
        }),
    );

    const list = await client.listCardanoDatabaseV2();
    const snap = selectSnapshot(list, "latest");
    const tipCertHash = snap.certificate_hash;
    console.log(
        JSON.stringify({
            phase: "tip_snapshot",
            snapHash: String(snap.hash).slice(0, 24),
            tipCertHash: String(tipCertHash).slice(0, 24),
            epoch: snap.beacon?.epoch,
            lastImm: snap.beacon?.immutable_file_number,
            merkleRoot: String(snap.merkle_root ?? "").slice(0, 24),
        }),
    );

    const chain = await walkCollectHashes(tipCertHash, fetcher, maxWalk);
    console.log(
        JSON.stringify({
            phase: "chain_collected",
            depth: chain.length,
            tip: chain[0]?.slice(0, 16),
            genesis: chain[chain.length - 1]?.slice(0, 16),
        }),
    );

    const samples = pickStratified(chain, nExtra, rng);

    // Optional: sprinkle a few random hashes from other CDB list certs
    const extraCdb = Math.min(4, list.length);
    for (let i = 0; i < extraCdb; i++) {
        const idx = Math.floor(rng() * list.length);
        const h = list[idx]?.certificate_hash;
        if (h && !samples.some((s) => s.hash === h)) {
            samples.push({ hash: h, kind: "random" });
        }
    }

    // Core dual-run opts — Stages 1–5d only in match gate.
    // CDB 5e–5h are side-channels; tip-only attachment below when WITH_CDB_SIDE=1.
    const dualOpts: PureTsVerifyOptions = {
        genesisVkey: gvk,
        fetcher,
        maxDepth: maxWalk,
        runChainWalk: true,
    };

    const rows: Row[] = [];
    let matchN = 0;
    let wasmN = 0;
    let failN = 0;
    let divergeN = 0;
    let maxNSig = 0;
    let weightedN2 = 0;
    const t0 = Date.now();

    for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        const t1 = Date.now();
        const dual = await dualRunCertificateChain(client, s.hash, dualOpts);
        const ms = Date.now() - t1;
        const pure = dual.pureTs;
        const stagesOk = pureTsFullChainStagesOk(pure);
        // dualRun already computes match; re-check formula for honesty
        const wasmOk = dual.wasm.ok === true;
        const match = dual.match === true;
        // formula must agree with dual.match (gate honesty)
        if (match !== (wasmOk && stagesOk)) {
            // counted later via gateBad on rows; still store stagesOk honestly
        }
        const nSig = nSigOf(pure);
        if (typeof nSig === "number") {
            maxNSig = Math.max(maxNSig, nSig);
            if (nSig >= 2) weightedN2++;
        }
        if (wasmOk) wasmN++;
        if (match) matchN++;
        else failN++;
        if (wasmOk && !match) divergeN++;

        const cert = dual.wasm.cert as Record<string, unknown> | null;
        const row: Row = {
            i,
            kind: s.kind,
            hash: s.hash,
            seType: seTypeOf(cert),
            epoch: epochOf(cert),
            isGenesis: isGenesisCertificate(
                (cert ?? {}) as Record<string, unknown>,
            ),
            wasmOk,
            match,
            stagesOk: stagesOk === true,
            chainOk: pure.chainOk === true,
            contentHashOk: pure.contentHashOk === true,
            shapeOk: pure.shapeOk === true,
            implemented: pure.implemented === true,
            ok: pure.ok === true,
            nSig,
            reason: pure.reason?.slice?.(0, 160),
            ms,
        };
        rows.push(row);

        console.log(
            JSON.stringify({
                phase: "progress",
                i,
                kind: row.kind,
                hash: row.hash.slice(0, 16),
                seType: row.seType,
                epoch: row.epoch,
                wasmOk: row.wasmOk,
                match: row.match,
                chainOk: row.chainOk,
                contentHashOk: row.contentHashOk,
                isGenesis: row.isGenesis,
                nSig: row.nSig,
                ms,
            }),
        );
    }

    const byKind: Record<string, { n: number; match: number; wasm: number }> =
        {};
    for (const r of rows) {
        const b = (byKind[r.kind] ??= { n: 0, match: 0, wasm: 0 });
        b.n++;
        if (r.match) b.match++;
        if (r.wasmOk) b.wasm++;
    }

    const implFlip = rows.filter((r) => r.implemented || r.ok).length;
    const gateBad = rows.filter((r) => {
        // re-check stored match vs wasmOk&&stagesOk
        return r.match !== (r.wasmOk && r.stagesOk);
    }).length;
    const tip = rows.find((r) => r.kind === "tip");
    const gen = rows.find((r) => r.kind === "genesis");

    let tipCdbSide: Record<string, unknown> | undefined;
    if (withCdbSide && tip) {
        // Side-channels only — never enter match gate.
        // merkle_root from tip snapshot for 5f; local imm for 5h if digests available.
        const tipSideOpts: PureTsVerifyOptions = {
            ...dualOpts,
            cardanoDatabaseMerkleRoot:
                typeof snap.merkle_root === "string" ? snap.merkle_root : undefined,
            cardanoDatabaseLastImmutableFileNumber:
                snap.beacon?.immutable_file_number,
            localImmutableDir: localImm,
        };
        const tipDual = await dualRunCertificateChain(
            client,
            tip.hash,
            tipSideOpts,
        );
        const p = tipDual.pureTs as {
            messageMatchOk?: boolean;
            cdbMessageMatchOk?: boolean;
            cdbMerkleRootOk?: boolean;
            cdbLocalDigestsOk?: boolean;
        };
        tipCdbSide = {
            messageMatchOk: p.messageMatchOk ?? null,
            cdbMessageMatchOk: p.cdbMessageMatchOk ?? null,
            cdbMerkleRootOk: p.cdbMerkleRootOk ?? null,
            cdbLocalDigestsOk: p.cdbLocalDigestsOk ?? null,
            note: "5e–5h side-channels only; not in match gate",
        };
    }

    const summary = {
        phase: "done",
        network,
        seed,
        out: outPath,
        sampleN: rows.length,
        chainDepth: chain.length,
        matchN,
        wasmN,
        failN,
        divergeN,
        maxNSig,
        weightedN2,
        byKind,
        gates: {
            allMatch: failN === 0 && matchN === rows.length,
            allWasm: wasmN === rows.length,
            zeroDiverge: divergeN === 0,
            noImplFlip: implFlip === 0,
            gateFormula: gateBad === 0,
            tipOk: tip?.match === true,
            genesisOk: gen?.match === true || gen === undefined,
            wasmStillSoT: rows.every((r) => !r.implemented && !r.ok),
        },
        tipCdbSide,
        tipRow: tip,
        genesisRow: gen,
        elapsedMs: Date.now() - t0,
        inventory: {
            pureTsStmImplemented: false,
            wasmIsSourceOfTruth: true,
            note: "chaos dual-run is assert-only; cutover is explicit product decision",
        },
        rows,
    };

    await Bun.write(outPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({
        phase: "done",
        out: outPath,
        sampleN: summary.sampleN,
        matchN,
        wasmN,
        failN,
        divergeN,
        byKind,
        gates: summary.gates,
        elapsedMs: summary.elapsedMs,
    }));

    client.free?.();

    const ok =
        summary.gates.allMatch &&
        summary.gates.allWasm &&
        summary.gates.zeroDiverge &&
        summary.gates.noImplFlip &&
        summary.gates.gateFormula &&
        summary.gates.wasmStillSoT;

    if (ok) {
        console.log("CHAOS_DUALRUN_OK");
        process.exit(0);
    }
    console.log("CHAOS_DUALRUN_FAIL");
    process.exit(1);
}

main().catch((e) => {
    console.error("CHAOS_DUALRUN_ERROR", e);
    process.exit(2);
});
