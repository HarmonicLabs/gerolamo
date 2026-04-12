// ---------------------------------------------------------------------------
// Wallet — key generation, address derivation, and tx submission
// Uses @harmoniclabs/cardano-ledger-ts + bip32_ed25519 (already in deps)
// ---------------------------------------------------------------------------

import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { XPrv } from "@harmoniclabs/bip32_ed25519";

export type NetworkId = "preprod" | "mainnet";

export interface WalletInfo {
  /** Bech32 address string */
  address: string;
  /** Hex-encoded root private key (encrypted in production) */
  xprvHex: string;
  network: NetworkId;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/** Generate 24 bytes (192 bits) of entropy for a wallet */
export function generateEntropy(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(24));
}

/** Derive a Cardano address from entropy bytes */
export function deriveAddress(entropy: Uint8Array, network: NetworkId): Address {
  return Address.fromEntropy(entropy, network === "mainnet" ? "mainnet" : "testnet");
}

/** Derive address from an existing XPrv */
export function deriveAddressFromXPrv(xprv: XPrv, network: NetworkId): Address {
  return Address.fromXPrv(xprv, network === "mainnet" ? "mainnet" : "testnet");
}

/** Create a new wallet — returns serializable wallet info */
export function createWallet(network: NetworkId = "preprod"): WalletInfo {
  const entropy = generateEntropy();
  const xprv = XPrv.fromEntropy(entropy);
  const address = Address.fromXPrv(xprv, network === "mainnet" ? "mainnet" : "testnet");

  return {
    address: address.toString(),
    xprvHex: Array.from(xprv.bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    network,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Wallet persistence (localStorage — works in extension popup)
// ---------------------------------------------------------------------------

const WALLET_KEY = "gerolamo:wallet";

export function saveWallet(wallet: WalletInfo): void {
  localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
}

export function loadWallet(): WalletInfo | null {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WalletInfo;
  } catch {
    return null;
  }
}

export function deleteWallet(): void {
  localStorage.removeItem(WALLET_KEY);
}

// ---------------------------------------------------------------------------
// UTxO query (via dashboard API)
// ---------------------------------------------------------------------------

export interface WalletUtxo {
  ref: string;
  txHash: string;
  outputIndex: number;
  address: string;
  amount: string;
  assets: Record<string, Record<string, string>>;
}

export async function queryWalletUtxos(apiBase: string, address: string): Promise<WalletUtxo[]> {
  const res = await fetch(`${apiBase}/api/utxo?q=${encodeURIComponent(address)}`);
  if (!res.ok) return [];
  return res.json();
}
