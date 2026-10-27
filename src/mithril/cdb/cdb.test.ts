import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompress } from "fzstd";

import { runMithrilBootstrap } from "../bootstrap";
import { buildSyntheticChain, type SyntheticChain } from "../verify/syntheticChain";
import { cardanoDbMerkleRoot, cardanoDbSnapshotHash, computeImmutableDigests, filterDigestsForBeacon, lastCompletedImmutable, listImmutableFiles } from "./digests";
import { buildImmutableArchive, produceCardanoDatabaseSnapshot } from "./produce";
import { createMithrilArtifactHandler } from "./server";
import { produceCertifiedSnapshot } from "./certify";
import { resolveMithrilServeConfig } from "./serveConfig";
import { describeVerification, verifyImmutableFiles } from "./verifyDownload";
import { ArtifactStore, pad5 } from "./store";
import { buildTar, readTar, type TarEntry } from "./tar";
import { MKTREE_GOLDEN_ROOT_HEX, verifyMkTreeGoldenRoot } from "../pureTs/mkTree";
import type { Logger } from "../../utils/logger";

const FIX = join(import.meta.dir, "..", "__fixtures__", "cdb");
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** Deterministic pseudo-random bytes. */
function bytes(seed: number, n: number): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = x & 0xff;
    }
    return out;
}

function writeTrio(dir: string, n: number): void {
    writeFileSync(join(dir, `${pad5(n)}.chunk`), bytes(n * 3 + 1, 20_000 + n * 777));
    writeFileSync(join(dir, `${pad5(n)}.primary`), bytes(n * 3 + 2, 1_000 + n));
    writeFileSync(join(dir, `${pad5(n)}.secondary`), bytes(n * 3 + 3, 3_000 + n * 5));
}

describe("cardano-database v2 artifacts", () => {
    test("tar writer: ustar entries round-trip", () => {
        const tar = buildTar([{ name: "immutable/00001.chunk", data: bytes(1, 1234) }, { name: "a.json", data: new Uint8Array() }]);
        expect(tar.length % 512).toBe(0);
        const back = readTar(tar);
        expect(back.map((e) => e.name)).toEqual(["immutable/00001.chunk", "a.json"]);
        expect(Buffer.compare(back[0]!.data, bytes(1, 1234))).toBe(0);
    });

    test("our immutable archive has the aggregator's layout and contents (00100, preview)", async () => {
        const published = readTar(decompress(readFileSync(join(FIX, "00100.tar.zst"))));
        expect(published.map((e) => e.name)).toEqual(["immutable/00100.chunk", "immutable/00100.primary", "immutable/00100.secondary"]);
        const dir = mkdtempSync(join(tmpdir(), "cdb-arch-"));
        try {
            mkdirSync(join(dir, "immutable"));
            for (const e of published) writeFileSync(join(dir, e.name), e.data);
            const digests = (await computeImmutableDigests(join(dir, "immutable"), { from: 100, to: 100 }));
            const want = JSON.parse(readFileSync(join(FIX, "00100.digests.json"), "utf8"));
            expect(digests).toEqual(want); // the certified digests of preview 00100.*
            const ours = await buildImmutableArchive(join(dir, "immutable"), 100, new Map(digests.map((d) => [d.immutable_file_name, d.digest])));
            const entries = readTar(decompress(ours.archive));
            expect(entries.map((e) => e.name)).toEqual(published.map((e) => e.name));
            for (let i = 0; i < 3; i++) expect(Buffer.compare(entries[i]!.data, published[i]!.data)).toBe(0);
            // Deterministic: a second build is byte-identical.
            const again = await buildImmutableArchive(join(dir, "immutable"), 100, new Map());
            expect(Buffer.compare(again.archive, ours.archive)).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("MKTree golden root and digest filtering", () => {
        expect(verifyMkTreeGoldenRoot().rootHex).toBe(MKTREE_GOLDEN_ROOT_HEX); // mithril-merkle-tree golden_merkle_root
        const list = [
            { immutable_file_name: "00002.chunk", digest: "AA".repeat(32) },
            { immutable_file_name: "00001.secondary", digest: "bb".repeat(32) },
            { immutable_file_name: "00003.chunk", digest: "cc".repeat(32) },
            { immutable_file_name: "garbage", digest: "dd".repeat(32) },
        ];
        expect(filterDigestsForBeacon(list, 2)).toEqual([
            { immutable_file_name: "00001.secondary", digest: "bb".repeat(32) },
            { immutable_file_name: "00002.chunk", digest: "aa".repeat(32) },
        ]);
    });

    test("serve config: off by default, config, --mithril-artifacts override", () => {
        expect(resolveMithrilServeConfig(undefined, null)).toBeNull();
        expect(resolveMithrilServeConfig({ artifactsDir: "/x" }, null)).toBeNull();
        expect(resolveMithrilServeConfig({ serveArtifacts: true, artifactsDir: "/x" }, null)?.artifactsDir).toBe("/x");
        expect(() => resolveMithrilServeConfig({ serveArtifacts: true }, null)).toThrow(/artifactsDir/);
        expect(resolveMithrilServeConfig(undefined, "/y")?.artifactsDir).toBe("/y");
        expect(resolveMithrilServeConfig({ serveArtifacts: true, artifactsDir: "/x" }, "0")).toBeNull();
    });

    test("download verification: extra trio needs its own digests (ancillary manifest)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cdb-ver-"));
        try {
            for (let n = 0; n <= 3; n++) writeTrio(dir, n);
            const d = await computeImmutableDigests(dir, { from: 0, to: 3 });
            const verified = { digests: new Map(d.filter((x) => !x.immutable_file_name.startsWith("00003")).map((x) => [x.immutable_file_name, x.digest])), merkleRoot: "", beacon: 2, source: "test" };
            const without = await verifyImmutableFiles(dir, { from: 0, to: 2 }, verified);
            expect(without.nonVerifiable).toEqual(["00003.chunk", "00003.primary", "00003.secondary"]);
            const extra = new Map(d.filter((x) => x.immutable_file_name.startsWith("00003")).map((x) => [x.immutable_file_name, x.digest]));
            const withExtra = await verifyImmutableFiles(dir, { from: 0, to: 2 }, verified, extra);
            expect(describeVerification(withExtra)).toBeNull();
            const missing = await verifyImmutableFiles(dir, { from: 0, to: 4 }, verified, extra);
            expect(missing.missing).toEqual(["00004.chunk", "00004.primary", "00004.secondary"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("snapshot hash rule (preview e1444/i28880 published hash)", () => {
        expect(cardanoDbSnapshotHash(1444, "5985ac8592ba7c9095705a8924b8a4ef1b0e650900690fbfb2697dca720973a0")).toBe("23156c7e7ff6b62fd423da43079df1e24048fba642e7ffdd211f6b19483674fb");
    });

    describe("produce, serve, bootstrap (offline, synthetic certificate chain)", () => {
        let root: string;
        let src: string;
        let store: ArtifactStore;
        let chain: SyntheticChain;
        let server: ReturnType<typeof Bun.serve>;
        let merkleRoot: string;

        beforeAll(async () => {
            root = mkdtempSync(join(tmpdir(), "cdb-e2e-"));
            src = join(root, "node", "immutable");
            mkdirSync(src, { recursive: true });
            for (let n = 0; n <= 3; n++) writeTrio(src, n); // 3 is the chunk "being written"
            const files = listImmutableFiles(src);
            expect(lastCompletedImmutable(files)).toBe(2);
            merkleRoot = cardanoDbMerkleRoot(await computeImmutableDigests(src, { from: 0, to: 2 }));
            chain = buildSyntheticChain({
                signedEntityType: { CardanoDatabase: { epoch: 10, immutable_file_number: 2 } },
                messageParts: { cardano_database_merkle_root: merkleRoot },
            });
            store = new ArtifactStore(join(root, "artifacts"));
            const r = await produceCardanoDatabaseSnapshot({
                immutableDir: src,
                store,
                network: "preview",
                beacon: { epoch: 10, immutableFileNumber: 2 },
                certificate: chain.standard,
                certificateChain: [chain.standard, chain.genesis],
                cardanoNodeVersion: "gerolamo-test",
            });
            expect(r.certified).toBe(true);
            expect(r.archivesWritten).toBe(3);
            expect(r.snapshot.hash).toBe(cardanoDbSnapshotHash(10, merkleRoot));
            const handler = createMithrilArtifactHandler({ store });
            server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (await handler(req, new URL(req.url))) ?? new Response("nope", { status: 404 }) });
        });
        afterAll(() => {
            server?.stop(true);
            rmSync(root, { recursive: true, force: true });
        });
        const base = () => `http://127.0.0.1:${server.port}/mithril`;

        test("producing a root the certificate did not sign is refused", async () => {
            const other = buildSyntheticChain({ signedEntityType: { CardanoDatabase: { epoch: 10, immutable_file_number: 2 } }, messageParts: { cardano_database_merkle_root: "00".repeat(32) } });
            await expect(produceCardanoDatabaseSnapshot({ immutableDir: src, store: new ArtifactStore(join(root, "other")), network: "preview", beacon: { epoch: 10, immutableFileNumber: 2 }, certificate: other.standard })).rejects.toThrow(/not the root certificate/);
        });

        test("routes: list, detail, certificate, digests", async () => {
            const list = (await (await fetch(`${base()}/artifact/cardano-database`)).json()) as { hash: string; certificate_hash: string }[];
            expect(list.length).toBe(1);
            expect(list[0]!.certificate_hash).toBe(chain.standard.hash);
            const detail = (await (await fetch(`${base()}/artifact/cardano-database/${list[0]!.hash}`)).json()) as { merkle_root: string; immutables: { locations: { uri: { Template: string } }[] } };
            expect(detail.merkle_root).toBe(merkleRoot);
            expect(detail.immutables.locations[0]!.uri.Template).toBe(`${base()}/cardano-database-download/immutable/{immutable_file_number}.tar.zst`);
            const cert = await fetch(`${base()}/certificate/${chain.genesis.hash}`);
            expect(await cert.text()).toBe(chain.texts.get(chain.genesis.hash)!);
            const digests = (await (await fetch(`${base()}/artifact/cardano-database/digests`)).json()) as unknown[];
            expect(digests.length).toBe(9);
            expect((await fetch(`${base()}/cardano-database-download/immutable/00009.tar.zst`)).status).toBe(404);
            expect((await fetch(`${base()}/cardano-database-download/../../etc/passwd`)).status).toBe(404);
            expect((await fetch(`${base()}/statistics/cardano-database/complete-restoration`, { method: "POST", body: "{}" })).status).toBe(201);
        });

        test("mithril-bootstrap restores byte-identical chunks from the served artifacts", async () => {
            const dl = join(root, "dl");
            const r = await runMithrilBootstrap({ network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, downloadDir: dl, skipApply: true, downloadConcurrency: 2 }, quiet);
            expect(r.verified).toBe(true);
            expect(r.certificateHash).toBe(chain.standard.hash);
            expect(r.downloadedChunks).toEqual([0, 1, 2]);
            for (let n = 0; n <= 2; n++) {
                for (const ext of ["chunk", "primary", "secondary"]) {
                    const name = `${pad5(n)}.${ext}`;
                    expect(Buffer.compare(readFileSync(join(r.immutableDir!, name)), readFileSync(join(src, name)))).toBe(0);
                }
            }
        });

        test("a stale trio left in a resumed download dir is fetched again", async () => {
            const dl = join(root, "dl-stale");
            mkdirSync(join(dl, "immutable"), { recursive: true });
            writeTrio(join(dl, "immutable"), 1);
            writeFileSync(join(dl, "immutable", "00001.chunk"), bytes(4242, 999)); // complete trio, wrong bytes
            const r = await runMithrilBootstrap({ network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, downloadDir: dl, skipApply: true }, quiet);
            expect(r.verified).toBe(true);
            expect(Buffer.compare(readFileSync(join(r.immutableDir!, "00001.chunk")), readFileSync(join(src, "00001.chunk")))).toBe(0);
        });

        test("a tampered archive is detected by the client", async () => {
            // Replace 00001's archive with one carrying different chunk bytes.
            const evil = join(root, "evil");
            mkdirSync(evil);
            writeTrio(evil, 1);
            writeFileSync(join(evil, "00001.chunk"), bytes(999, 20_777));
            const { archive } = await buildImmutableArchive(evil, 1, new Map());
            const path = store.immutableArchive(1);
            const good = readFileSync(path);
            writeFileSync(path, archive);
            try {
                await expect(runMithrilBootstrap({ network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, downloadDir: join(root, "dl-evil"), skipApply: true }, quiet)).rejects.toThrow(/tampered \(00001\.chunk\)/);
            } finally {
                writeFileSync(path, good);
            }
        });

        test("an archive carrying another trio's file is refused", async () => {
            const evil = join(root, "evil2");
            mkdirSync(join(evil, "immutable"), { recursive: true });
            const entries: TarEntry[] = ["chunk", "primary", "secondary"].map((e) => ({ name: `immutable/00001.${e}`, data: new Uint8Array(readFileSync(join(src, `00001.${e}`))) }));
            entries.push({ name: "immutable/00000.chunk", data: bytes(5, 100) });
            const path = store.immutableArchive(1);
            const good = readFileSync(path);
            writeFileSync(path, await Bun.zstdCompress(buildTar(entries)));
            try {
                await expect(runMithrilBootstrap({ network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, downloadDir: join(root, "dl-evil2"), skipApply: true }, quiet)).rejects.toThrow(/unexpected entries|tampered/);
            } finally {
                writeFileSync(path, good);
            }
        });

        test("mithril-produce certifies a second copy of the chunks against the served snapshot", async () => {
            // The served store acts as the aggregator: same list/certificate routes.
            const copy = join(root, "copy", "immutable");
            mkdirSync(copy, { recursive: true });
            for (let n = 0; n <= 3; n++) writeTrio(copy, n);
            const r = await produceCertifiedSnapshot({ immutableDir: copy, store: new ArtifactStore(join(root, "artifacts2")), network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, archiveRange: { from: 0, to: 0 } });
            expect(r.certified).toBe(true);
            expect(r.target.verify.hops.length).toBe(2);
            expect(r.snapshot.hash).toBe(cardanoDbSnapshotHash(10, merkleRoot));
            expect(r.archivesWritten).toBe(1);
            // Different bytes in one file: the root no longer matches the certificate.
            writeFileSync(join(copy, "00002.secondary"), bytes(77, 10));
            await expect(produceCertifiedSnapshot({ immutableDir: copy, store: new ArtifactStore(join(root, "artifacts3")), network: "preview", aggregator: base(), genesisVkey: chain.genesisVkeyHex, archiveRange: { from: 0, to: 0 } })).rejects.toThrow(/not the root certificate/);
        });

        test("a wrong genesis key rejects the chain", async () => {
            const key = Buffer.from(JSON.stringify(Array.from({ length: 32 }, (_, i) => i)), "utf8").toString("hex");
            await expect(runMithrilBootstrap({ network: "preview", aggregator: base(), genesisVkey: key, downloadDir: join(root, "dl-key"), skipApply: true }, quiet)).rejects.toThrow(/CertificateGenesis/);
        });
    });
});
