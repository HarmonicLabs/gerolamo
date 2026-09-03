import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";

/**
 * Byron genesis UTxO set.
 *
 * cardano-ledger-byron builds the initial UTxO from the genesis file: every
 * funded address becomes one output at `TxIn (hash address) 0`, where the
 * "tx id" is blake2b-256 of the address's CBOR serialisation — which for a
 * Byron address is exactly its base58-decoded bytes. Verified against preprod:
 * the first transaction (slot 86420, b75ec46c…) spends
 * 5526b1373acfc774794a62122f95583ff17febb2ca8a0fe948d097e29cf99099:0, the id
 * of the single funded `nonAvvmBalances` address.
 *
 * `avvmDistr` (mainnet: 14,505 entries) maps base64url redeem public keys to
 * lovelace; the address is `ByronAddress.fromRedeemPublicKey(pk)` (type 2, no
 * attributes on mainnet) and the UTxO id again blake2b-256 of its bytes.
 * Verified against mainnet via Blockfrost for three entries (see the
 * ledger-ts ByronAddress tests).
 */
export interface GenesisUtxo {
    /** `<txId>:<index>` as stored in the utxo table. */
    utxoRef: string;
    txId: string;
    address: string;
    lovelace: bigint;
    kind: "nonavvm" | "avvm";
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
    if (s.length === 0) return new Uint8Array(0);
    const bytes: number[] = [];
    for (const ch of s) {
        let carry = B58_INDEX.get(ch);
        if (carry === undefined) throw new Error(`invalid base58 character '${ch}'`);
        for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i]! * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    let leading = 0;
    for (const ch of s) {
        if (ch !== "1") break;
        leading++;
    }
    const out = new Uint8Array(leading + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[leading + i] = bytes[bytes.length - 1 - i]!;
    return out;
}

/** Genesis "tx id" for a Byron base58 address: blake2b-256 of its bytes. */
export function byronGenesisUtxoId(addressBase58: string): string {
    return toHex(blake2b_256(base58Decode(addressBase58)));
}

export interface ByronGenesisBalances {
    nonAvvmBalances?: Record<string, string | number>;
    avvmDistr?: Record<string, string | number>;
    protocolConsts?: { protocolMagic?: number };
}

export function base64urlDecode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Redeem (AVVM) genesis entry → its Byron address (base58) and UTxO id. */
export function avvmGenesisAddress(redeemPkBase64url: string, protocolMagic?: number): { address: string; txId: string } {
    const pk = base64urlDecode(redeemPkBase64url);
    const addr = ByronAddress.fromRedeemPublicKey(pk, protocolMagic);
    return { address: addr.toBase58(), txId: toHex(blake2b_256(addr.toBytes())) };
}

export function byronGenesisUtxos(genesis: ByronGenesisBalances): { utxos: GenesisUtxo[]; nonAvvm: number; avvm: number } {
    const utxos: GenesisUtxo[] = [];
    let nonAvvm = 0;
    let avvm = 0;
    for (const [address, bal] of Object.entries(genesis.nonAvvmBalances ?? {})) {
        const lovelace = BigInt(String(bal));
        if (lovelace <= 0n) continue; // zero-value genesis entries carry no UTxO
        const txId = byronGenesisUtxoId(address);
        utxos.push({ utxoRef: `${txId}:0`, txId, address, lovelace, kind: "nonavvm" });
        nonAvvm++;
    }
    const magic = genesis.protocolConsts?.protocolMagic;
    for (const [pk, bal] of Object.entries(genesis.avvmDistr ?? {})) {
        const lovelace = BigInt(String(bal));
        if (lovelace <= 0n) continue;
        const { address, txId } = avvmGenesisAddress(pk, magic);
        utxos.push({ utxoRef: `${txId}:0`, txId, address, lovelace, kind: "avvm" });
        avvm++;
    }
    return { utxos, nonAvvm, avvm };
}

/** How many genesis UTxOs `byronGenesisUtxos` would produce — without deriving any address. */
export function countFundedGenesisEntries(genesis: ByronGenesisBalances): number {
    let n = 0;
    for (const bal of Object.values(genesis.nonAvvmBalances ?? {})) if (BigInt(String(bal)) > 0n) n++;
    for (const bal of Object.values(genesis.avvmDistr ?? {})) if (BigInt(String(bal)) > 0n) n++;
    return n;
}
