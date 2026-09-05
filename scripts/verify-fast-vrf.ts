#!/usr/bin/env bun
/** Cross-check the fast ECVRF verifier against the reference on stored Shelley-era headers. */
import { Database } from "bun:sqlite";
import { MultiEraHeader, ShelleyHeader } from "@harmoniclabs/cardano-ledger-ts";
import { VrfProof03 } from "@harmoniclabs/crypto";
import { vrf03Verify } from "../src/consensus/fastVrf";
import * as vi from "../src/consensus/vrfInputs";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const limit = Number(args.limit ?? 500);
const rows = db.query("SELECT slot, header_data FROM blocks WHERE slot >= ? ORDER BY slot LIMIT ?").all(Number(args.from ?? 86400), limit) as any[];
const nonces = new Map<number, Uint8Array>((db.query("SELECT epoch, nonce_hex FROM epoch_nonces").all() as any[]).map((r) => [Number(r.epoch), Buffer.from(r.nonce_hex, "hex")]));
const epochOf = (slot: number) => 4 + Math.floor((slot - 86400) / 432000);
let n = 0, agree = 0, fastOk = 0, libOk = 0, tFast = 0, tLib = 0, skipped = 0;
for (const r of rows) {
    let h: any;
    try { h = new MultiEraHeader({ era: 2, header: ShelleyHeader.fromCbor(new Uint8Array(r.header_data)) } as any).header; } catch { skipped++; continue; }
    const body = h.body ?? h.headerBody;
    const nonce = nonces.get(epochOf(Number(r.slot)));
    if (!nonce) { skipped++; continue; }
    const pk: Uint8Array = body.vrfPubKey?.toBuffer?.() ?? body.vrfPubKey;
    for (const [kind, cert] of [["leader", body.leaderVrfResult], ["nonce", body.nonceVrfResult]] as const) {
        const input = (vi as any).tpraosVrfInput(BigInt(r.slot), nonce, kind);
        const proofBytes: Uint8Array = cert.proof?.toBuffer?.() ?? cert.proof;
        const out: Uint8Array = cert.proofHash?.toBuffer?.() ?? cert.proofHash ?? cert.output;
        n++;
        let t0 = performance.now();
        const fast = vrf03Verify(pk, input, proofBytes);
        tFast += performance.now() - t0;
        t0 = performance.now();
        const proof = VrfProof03.fromBytes(proofBytes);
        const lib = proof.verify(pk, input);
        tLib += performance.now() - t0;
        const fastValid = !!fast && Buffer.from(fast).equals(Buffer.from(out));
        if (fastValid) fastOk++;
        if (lib) libOk++;
        if (fastValid === lib) agree++;
        else if (n < 20) console.log("DISAGREE slot", r.slot, kind, "fast", fastValid, "lib", lib);
    }
}
console.log({ headers: rows.length, proofs: n, agree, fastOk, libOk, skipped, fastMs: (tFast / n).toFixed(3), libMs: (tLib / n).toFixed(2) });
