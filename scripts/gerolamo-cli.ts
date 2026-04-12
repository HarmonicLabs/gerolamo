#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// gerolamo-cli — cardano-cli-like functionality for Gerolamo
//
// Acts exactly like running a full Cardano node's CLI: wallet generation,
// key management, address derivation, UTxO queries, tip queries, tx
// submission — all powered by the Gerolamo TypeScript node.
//
// Usage:
//   bun scripts/gerolamo-cli.ts <command> [options]
//
// Commands:
//   query tip                         — Query the current tip of the chain
//   query utxo --address <addr>       — Query UTxOs for an address
//   query utxo --tx-hash <hash>       — Query UTxOs for a tx hash
//   query chain-state                 — Query treasury, reserves, pool/stake counts
//   query peers                       — Show topology peers
//   wallet generate                   — Generate a new preprod wallet
//   wallet show                       — Show the current wallet
//   wallet delete                     — Delete the saved wallet
//   wallet balance                    — Query balance for current wallet
//   address info <addr>               — Decode a Cardano address
//   tx submit --file <path>           — Submit a signed transaction (CBOR file)
//   node status                       — Full node status
//   node start                        — Start the Gerolamo node (delegates to start-gerolamo)
// ---------------------------------------------------------------------------

import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { XPrv } from "@harmoniclabs/bip32_ed25519";

const ROOT = resolve(import.meta.dir, "..");
const WALLET_FILE = resolve(ROOT, ".gerolamo-wallet.json");
const API_BASE = process.env.GEROLAMO_API ?? "http://localhost:3050";
const NODE_URL = process.env.GEROLAMO_NODE ?? "http://localhost:3030";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[90m${s}\x1b[0m`; }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function lovelaceToAda(lovelace: string | number | bigint): string {
  return (Number(BigInt(lovelace)) / 1_000_000).toFixed(6);
}

// ---------------------------------------------------------------------------
// Wallet persistence (file-based for CLI)
// ---------------------------------------------------------------------------

interface WalletInfo {
  address: string;
  xprvHex: string;
  network: string;
  createdAt: string;
}

function saveWallet(w: WalletInfo): void {
  writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2));
}

function loadWallet(): WalletInfo | null {
  if (!existsSync(WALLET_FILE)) return null;
  try { return JSON.parse(readFileSync(WALLET_FILE, "utf-8")); } catch { return null; }
}

function deleteWalletFile(): void {
  if (existsSync(WALLET_FILE)) unlinkSync(WALLET_FILE);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

async function run() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  switch (cmd) {
    case "query":
      await runQuery();
      break;
    case "wallet":
      await runWallet();
      break;
    case "address":
      await runAddress();
      break;
    case "tx":
      await runTx();
      break;
    case "node":
      await runNode();
      break;
    default:
      console.error(red(`Unknown command: ${cmd}`));
      printHelp();
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

async function runQuery() {
  switch (sub) {
    case "tip": {
      const status = await fetchJson<any>(`${API_BASE}/api/status`);
      const tip = status.tip;
      console.log(bold("Current Tip"));
      console.log(`  Slot:    ${cyan(String(tip.slot))}`);
      console.log(`  Hash:    ${tip.hash || dim("(empty)")}`);
      console.log(`  Epoch:   ${tip.epoch}`);
      console.log(`  Era:     ${["Byron","Shelley","Allegra","Mary","Alonzo","Babbage","Conway"][tip.era] ?? tip.era}`);
      console.log(`  Sync:    ${(status.sync.progress * 100).toFixed(2)}%`);
      console.log(`  Speed:   ${status.sync.speed} slots/min`);
      break;
    }
    case "utxo": {
      const addr = getFlag("--address");
      const txHash = getFlag("--tx-hash");
      const q = addr || txHash;
      if (!q) { console.error(red("Usage: query utxo --address <addr> | --tx-hash <hash>")); process.exit(1); }
      const utxos = await fetchJson<any[]>(`${API_BASE}/api/utxo?q=${encodeURIComponent(q)}`);
      if (utxos.length === 0) {
        console.log(yellow("No UTxOs found."));
        return;
      }
      console.log(bold(`UTxOs (${utxos.length} found)`));
      console.log(dim("─".repeat(80)));
      let total = 0n;
      for (const u of utxos) {
        const amt = BigInt(u.amount || "0");
        total += amt;
        console.log(`  ${cyan(u.ref)}`);
        console.log(`    Address: ${u.address ? u.address.slice(0, 40) + "..." : dim("unknown")}`);
        console.log(`    Amount:  ${green(lovelaceToAda(amt) + " ADA")} ${dim(`(${amt} lovelace)`)}`);
        const assetKeys = Object.keys(u.assets || {});
        if (assetKeys.length > 0) {
          for (const policy of assetKeys) {
            for (const [name, qty] of Object.entries(u.assets[policy])) {
              console.log(`    Token:   ${policy.slice(0, 12)}...${name} × ${qty}`);
            }
          }
        }
      }
      console.log(dim("─".repeat(80)));
      console.log(`  ${bold("Total:")} ${green(lovelaceToAda(total) + " ADA")}`);
      break;
    }
    case "chain-state": {
      const cs = await fetchJson<any>(`${API_BASE}/api/chain-state`);
      console.log(bold("Chain State"));
      console.log(`  Treasury:     ${green(lovelaceToAda(cs.treasury) + " ADA")}`);
      console.log(`  Reserves:     ${lovelaceToAda(cs.reserves)} ADA`);
      console.log(`  Pool Count:   ${cs.poolCount}`);
      console.log(`  Stake Count:  ${cs.stakeCount}`);
      console.log(`  Delegations:  ${cs.delegationCount}`);
      break;
    }
    case "peers": {
      const peers = await fetchJson<any[]>(`${API_BASE}/api/peers`);
      console.log(bold(`Peers (${peers.length})`));
      for (const p of peers) {
        const cat = p.category === "bootstrap" ? cyan("bootstrap") : p.category;
        console.log(`  ${p.host}:${p.port}  [${cat}]`);
      }
      break;
    }
    default:
      console.error(red(`Unknown query subcommand: ${sub}`));
      console.log("Available: tip, utxo, chain-state, peers");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

async function runWallet() {
  switch (sub) {
    case "generate": {
      const entropy = crypto.getRandomValues(new Uint8Array(24));
      const xprv = XPrv.fromEntropy(entropy);
      const address = Address.fromXPrv(xprv, "testnet");
      const xprvHex = Array.from(xprv.bytes, (b) => b.toString(16).padStart(2, "0")).join("");

      const wallet: WalletInfo = {
        address: address.toString(),
        xprvHex,
        network: "preprod",
        createdAt: new Date().toISOString(),
      };
      saveWallet(wallet);

      console.log(bold("Wallet Generated"));
      console.log(`  Network:  ${cyan("preprod")}`);
      console.log(`  Address:  ${green(wallet.address)}`);
      console.log(`  Saved:    ${dim(WALLET_FILE)}`);
      console.log("");
      console.log(yellow("  Fund this address via the Cardano preprod faucet:"));
      console.log(dim("  https://docs.cardano.org/cardano-testnets/tools/faucet/"));
      break;
    }
    case "show": {
      const w = loadWallet();
      if (!w) { console.log(yellow("No wallet found. Run: gerolamo-cli wallet generate")); return; }
      console.log(bold("Wallet"));
      console.log(`  Network:  ${cyan(w.network)}`);
      console.log(`  Address:  ${green(w.address)}`);
      console.log(`  Created:  ${dim(w.createdAt)}`);
      if (hasFlag("--show-key")) {
        console.log(`  XPrv:     ${red(w.xprvHex)}`);
      } else {
        console.log(dim("  (use --show-key to reveal private key)"));
      }
      break;
    }
    case "delete": {
      deleteWalletFile();
      console.log(green("Wallet deleted."));
      break;
    }
    case "balance": {
      const w = loadWallet();
      if (!w) { console.log(yellow("No wallet found. Run: gerolamo-cli wallet generate")); return; }
      console.log(`Querying UTxOs for ${w.address.slice(0, 20)}...`);
      const utxos = await fetchJson<any[]>(`${API_BASE}/api/utxo?q=${encodeURIComponent(w.address)}`);
      const total = utxos.reduce((acc: bigint, u: any) => acc + BigInt(u.amount || "0"), 0n);
      console.log(bold("Balance"));
      console.log(`  Address:  ${w.address}`);
      console.log(`  UTxOs:    ${utxos.length}`);
      console.log(`  Balance:  ${green(lovelaceToAda(total) + " ADA")} ${dim(`(${total} lovelace)`)}`);
      break;
    }
    default:
      console.error(red(`Unknown wallet subcommand: ${sub}`));
      console.log("Available: generate, show, delete, balance");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

async function runAddress() {
  if (sub !== "info" || !args[2]) {
    console.error(red("Usage: address info <bech32-address>"));
    process.exit(1);
  }
  const addrStr = args[2];
  try {
    const addr = Address.fromString(addrStr);
    console.log(bold("Address Info"));
    console.log(`  Bech32:       ${green(addrStr)}`);
    console.log(`  Type:         ${addr.type}`);
    console.log(`  Network:      ${addr.network === "mainnet" ? "mainnet" : "testnet (preprod)"}`);
    const bytes = addr.toBuffer();
    const hex = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    console.log(`  Hex:          ${dim(hex)}`);
  } catch (e: any) {
    console.error(red(`Invalid address: ${e.message}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// tx
// ---------------------------------------------------------------------------

async function runTx() {
  if (sub !== "submit") {
    console.error(red("Usage: tx submit --file <path-to-signed-tx.cbor>"));
    process.exit(1);
  }
  const file = getFlag("--file");
  if (!file || !existsSync(file)) {
    console.error(red("Provide a valid CBOR file: tx submit --file <path>"));
    process.exit(1);
  }
  const txCbor = readFileSync(file);
  console.log(`Submitting ${txCbor.length} bytes to ${NODE_URL}/txsubmit ...`);
  try {
    const res = await fetch(`${API_BASE}/api/txsubmit`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: txCbor,
      signal: AbortSignal.timeout(10000),
    });
    const result = await res.text();
    if (res.ok) {
      console.log(green("Transaction submitted successfully."));
      console.log(`  Response: ${result}`);
    } else {
      console.error(red(`Submission failed (HTTP ${res.status}): ${result}`));
    }
  } catch (e: any) {
    console.error(red(`Submit error: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

async function runNode() {
  switch (sub) {
    case "status": {
      const status = await fetchJson<any>(`${API_BASE}/api/status`);
      console.log(bold("Node Status"));
      console.log(`  Network:         ${cyan(status.network)}`);
      console.log(`  Tip Slot:        ${cyan(String(status.tip.slot))}`);
      console.log(`  Tip Hash:        ${status.tip.hash || dim("(empty)")}`);
      console.log(`  Epoch:           ${status.tip.epoch}`);
      console.log(`  Era:             ${["Byron","Shelley","Allegra","Mary","Alonzo","Babbage","Conway"][status.tip.era] ?? status.tip.era}`);
      console.log(`  Sync Progress:   ${(status.sync.progress * 100).toFixed(2)}%`);
      console.log(`  Sync Speed:      ${status.sync.speed} slots/min`);
      console.log(`  Uptime:          ${Math.floor(status.uptime / 1000)}s`);
      console.log(`  Volatile Blocks: ${status.volatileBlocks}`);
      console.log(`  Immutable Blocks:${status.immutableBlocks}`);
      console.log(`  UTxO Count:      ${status.utxoCount}`);
      console.log(`  Mempool Size:    ${status.mempoolSize}`);
      break;
    }
    case "start": {
      console.log("Starting Gerolamo node...");
      const proc = Bun.spawn(["bun", "src/index.ts", "start-gerolamo"], {
        cwd: ROOT,
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
      break;
    }
    default:
      console.error(red(`Unknown node subcommand: ${sub}`));
      console.log("Available: status, start");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
${bold("gerolamo-cli")} — Cardano full node CLI (TypeScript)

${bold("USAGE")}
  bun scripts/gerolamo-cli.ts <command> [subcommand] [options]

${bold("COMMANDS")}
  ${cyan("query tip")}                            Query current chain tip
  ${cyan("query utxo")} --address <addr>           Query UTxOs by address
  ${cyan("query utxo")} --tx-hash <hash>           Query UTxOs by tx hash
  ${cyan("query chain-state")}                     Treasury, reserves, pools, stakes
  ${cyan("query peers")}                           Show topology peers

  ${cyan("wallet generate")}                       Generate a new preprod wallet
  ${cyan("wallet show")} [--show-key]               Show current wallet
  ${cyan("wallet delete")}                         Delete saved wallet
  ${cyan("wallet balance")}                        Query wallet balance

  ${cyan("address info")} <bech32>                  Decode a Cardano address

  ${cyan("tx submit")} --file <path.cbor>           Submit a signed transaction

  ${cyan("node status")}                           Full node status
  ${cyan("node start")}                            Start the Gerolamo node

${bold("ENVIRONMENT")}
  GEROLAMO_API   Dashboard API base (default: http://localhost:3050)
  GEROLAMO_NODE  Node URL (default: http://localhost:3030)
`);
}

// Run
run().catch((e) => {
  console.error(red(`Error: ${e.message}`));
  process.exit(1);
});
