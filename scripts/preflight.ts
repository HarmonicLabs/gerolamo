#!/usr/bin/env bun
/**
 * Fresh-clone preflight: says exactly what is missing to run the node and the
 * desktop Control Center, with install hints for the current distro.
 *
 *   bun run preflight          (also runs at the start of `bun run ui:dev`)
 *
 * Exit 1 only for things that will definitely break: missing Bun deps or
 * missing WebKitGTK/GTK system libraries for the desktop app.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const ok: string[] = [];
const warn: string[] = [];
const fail: string[] = [];

function which(cmd: string): string | null {
    const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
}

function distro(): { id: string; like: string } {
    try {
        const s = readFileSync("/etc/os-release", "utf8");
        const get = (k: string) => (s.match(new RegExp(`^${k}=\"?([^\"\\n]+)`, "m")) ?? [])[1] ?? "";
        return { id: get("ID"), like: get("ID_LIKE") };
    } catch {
        return { id: "", like: "" };
    }
}

// --- Bun -------------------------------------------------------------------
const bunVer = (globalThis as { Bun?: { version: string } }).Bun?.version ?? "";
const [maj, min] = bunVer.split(".").map(Number);
if (maj > 1 || (maj === 1 && (min ?? 0) >= 1)) ok.push(`bun ${bunVer}`);
else fail.push(`bun ${bunVer || "?"} is too old; install ≥ 1.1 from https://bun.sh`);

// --- JS dependencies ---------------------------------------------------------
const need = [
    ["node_modules/@harmoniclabs/cardano-ledger-ts/package.json", "root dependencies", "bun install"],
    ["desktop/node_modules/electrobun/package.json", "desktop dependencies (Electrobun)", "bun install --cwd desktop"],
    ["dashboard/node_modules/solid-js/package.json", "dashboard dependencies", "bun install --cwd dashboard"],
] as const;
for (const [rel, what, fix] of need) {
    if (existsSync(join(root, rel))) ok.push(what);
    else fail.push(`${what} missing → run \`${fix}\` (root \`bun install\` does all three)`);
}

// --- Electrobun runtime + system libraries (Linux) ---------------------------
const ebDist = join(root, "desktop/node_modules/electrobun", `dist-${process.platform}-${process.arch}`);
if (process.platform === "linux") {
    const own = new Set(["libasar.so", "libNativeWrapper.so", "libNativeWrapper_cef.so", "libwebgpu_dawn.so"]);
    const d = distro();
    const apt = "sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0 libayatana-appindicator3-1 libdbusmenu-gtk3-4 rsync";
    const dnf = "sudo dnf install webkit2gtk4.1 gtk3 libsoup3 libayatana-appindicator-gtk3 libdbusmenu-gtk3 rsync";
    const pacman = "sudo pacman -S webkit2gtk-4.1 gtk3 libsoup3 libayatana-appindicator libdbusmenu-gtk3 rsync";
    const hint = /debian|ubuntu/.test(d.id + d.like) ? apt : /fedora|rhel|centos/.test(d.id + d.like) ? dnf : /arch/.test(d.id + d.like) ? pacman : `${apt}\n      (Debian/Ubuntu)  or  ${dnf}  (Fedora)`;
    const wrapper = join(ebDist, "libNativeWrapper.so");
    if (existsSync(wrapper)) {
        const ldd = which("ldd");
        if (ldd) {
            const r = spawnSync(ldd, [wrapper], { encoding: "utf8" });
            const missing = r.stdout.split("\n").filter((l) => l.includes("not found")).map((l) => l.trim().split(/\s+/)[0]!).filter((l) => !own.has(l));
            if (missing.length === 0) ok.push("Electrobun runtime present; all system libraries found");
            else fail.push(`system libraries missing for the desktop app: ${missing.join(", ")}\n      fix: ${hint}`);
        } else warn.push("ldd not available; cannot verify WebKitGTK/GTK libraries");
    } else {
        // Runtime is fetched by the Electrobun CLI on first `electrobun dev` (~150 MB from GitHub releases).
        const probe = ["libwebkit2gtk-4.1.so.0", "libgtk-3.so.0", "libsoup-3.0.so.0", "libayatana-appindicator3.so.1"];
        const ldconfig = which("ldconfig");
        const cache = ldconfig ? spawnSync(ldconfig, ["-p"], { encoding: "utf8" }).stdout : "";
        const missing = cache ? probe.filter((l) => !cache.includes(l)) : [];
        if (missing.length) fail.push(`system libraries missing for the desktop app: ${missing.join(", ")}\n      fix: ${hint}`);
        else ok.push("WebKitGTK/GTK system libraries present");
        warn.push("Electrobun Linux runtime not downloaded yet: first `bun run ui:dev` fetches ~150 MB from GitHub (needs network + tar)");
    }
    for (const [tool, why, hard] of [["rsync", "used by desktop/scripts/dev-wait.sh", true], ["tar", "Electrobun runtime download", true], ["zenity", "folder picker in the Control Center (kdialog also works)", false]] as const) {
        if (which(tool) || (tool === "zenity" && which("kdialog"))) ok.push(tool);
        else (hard ? fail : warn).push(`${tool} not found (${why})`);
    }
} else {
    warn.push(`platform ${process.platform}: the desktop app is only exercised on Linux so far`);
}

// --- Report ------------------------------------------------------------------
console.log("Gerolamo preflight");
for (const s of ok) console.log(`  ok    ${s}`);
for (const s of warn) console.log(`  note  ${s}`);
for (const s of fail) console.log(`  FAIL  ${s}`);
if (fail.length === 0) {
    console.log("\nReady:  NETWORK=preprod bun src/index.ts start-gerolamo   |   bun run ui:dev");
    process.exit(0);
}
console.log(`\n${fail.length} blocking issue(s).`);
process.exit(1);
