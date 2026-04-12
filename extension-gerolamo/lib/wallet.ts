// ---------------------------------------------------------------------------
// Wallet — key generation, address derivation, persistence
// Uses @harmoniclabs/cardano-ledger-ts + bip32_ed25519
// ---------------------------------------------------------------------------

import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { XPrv } from "@harmoniclabs/bip32_ed25519";

export type NetworkId = "preprod" | "mainnet";

export interface WalletInfo {
  address: string;
  xprvHex: string;
  network: NetworkId;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export function generateEntropy(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(24));
}

export function deriveAddress(entropy: Uint8Array, network: NetworkId): Address {
  return Address.fromEntropy(entropy, network === "mainnet" ? "mainnet" : "testnet");
}

export function deriveAddressFromXPrv(xprv: XPrv, network: NetworkId): Address {
  return Address.fromXPrv(xprv, network === "mainnet" ? "mainnet" : "testnet");
}

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
// Wallet persistence (chrome.storage.local)
// ---------------------------------------------------------------------------

const WALLET_KEY = "gerolamo:wallet";

export async function saveWallet(wallet: WalletInfo): Promise<void> {
  const json = JSON.stringify(wallet);
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ [WALLET_KEY]: json });
    } else {
      localStorage.setItem(WALLET_KEY, json);
    }
  } catch {}
}

export async function loadWallet(): Promise<WalletInfo | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const result = await chrome.storage.local.get(WALLET_KEY);
      const raw = result[WALLET_KEY];
      if (!raw) return null;
      return JSON.parse(raw) as WalletInfo;
    } else {
      const raw = localStorage.getItem(WALLET_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as WalletInfo;
    }
  } catch {
    return null;
  }
}

export async function deleteWallet(): Promise<void> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.remove(WALLET_KEY);
    } else {
      localStorage.removeItem(WALLET_KEY);
    }
  } catch {}
}
