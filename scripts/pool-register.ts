/**
 * Operator flow on the HarmonicLabs libraries (pool tooling plan §2):
 *
 *   bun scripts/pool-register.ts keygen  --dir <pooldir> [--network preview]
 *       cold/KES/VRF keys, counter, payment/stake keys and addresses (cardano-cli file formats)
 *   bun scripts/pool-register.ts opcert  --dir <pooldir> --node http://localhost:3035
 *       issue node.cert for the current KES period from the node's tip, bump node.counter
 *   bun scripts/pool-register.ts register --dir <pooldir> --node http://localhost:3035 \
 *       --pledge <lovelace> --cost <lovelace> --margin 0.01 --relay host:port [--relay ip:port …] \
 *       [--metadata-url URL --metadata-file FILE] [--skip-stake-reg] [--ttl 7200] [--submit]
 *       builds stake registration + pool registration + owner delegation, signs with payment,
 *       stake and cold keys, writes tx.signed (TextEnvelope) and optionally submits to the node.
 *
 * Fund the payment address (payment.addr) from the faucet first; the transaction spends every
 * lovelace-only UTxO at that address and returns the change minus deposits and fee.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import {
    EnvelopeType, encodeIssueCounter, encodeOperationalCert, envelopeOfBytes, generateColdKey, generateKesKey, generateVrfKey, issueOperationalCert,
    kesPeriodOfSlot, kesSecretForEnvelope, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey, poolIdOf, readIssueCounter, vrfKeyHashOf, writeTextEnvelope,
} from "../src/pool/keystore";
import {
    addressBech32, baseAddressBytes, bech32Decode, buildWithMinFee, certificateEnvelope, generateKeyPair, keyEnvelopes, keyHash, KeyEnvelopeType, loadSigningKey,
    marginFromDecimal, poolMetadataHash, poolRegistrationCert, stakeAddressBytes, stakeDelegationCert, stakeRegistrationCert, txEnvelope, txId, type Relay,
} from "../src/pool/operator";

const argv = process.argv.slice(2);
const cmd = argv[0];
const args: Record<string, string[]> = {};
for (let i = 1; i < argv.length; i++) {
    if (!argv[i]!.startsWith("--")) continue;
    const k = argv[i]!.slice(2), v = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    (args[k] ??= []).push(v);
}
const arg = (k: string, d?: string) => args[k]?.[0] ?? d;
const need = (k: string) => { const v = arg(k); if (!v) { console.error(`missing --${k}`); process.exit(2); } return v; };
const dir = need("dir");
const networkId = (arg("network", "preview") === "mainnet" ? 1 : 0) as 0 | 1;
const file = (n: string) => join(dir, n);

async function nodeJson<T>(path: string): Promise<T> {
    const base = need("node").replace(/\/$/, "");
    const r = await fetch(base + path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
}

async function tipAndParams() {
    const m = await nodeJson<any>("/metrics");
    const epoch = Number(m.epoch);
    const p = await nodeJson<any>(`/api/v0/epochs/${epoch}/parameters`);
    const genesis = await Bun.file(`src/config/${arg("network", "preview")}/shelley-genesis.json`).json();
    return { tipSlot: BigInt(m.tipSlot), epoch, params: p, genesis, network: String(m.network) };
}

if (cmd === "keygen") {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file("cold.skey"))) { console.error(`${file("cold.skey")} exists; refusing to overwrite keys`); process.exit(1); }
    const cold = generateColdKey(), kes = generateKesKey(), vrf = generateVrfKey();
    writeTextEnvelope(file("cold.skey"), envelopeOfBytes(EnvelopeType.coldSigningKey, "Stake Pool Operator Signing Key", cold.skey));
    writeTextEnvelope(file("cold.vkey"), envelopeOfBytes(EnvelopeType.coldVerificationKey, "Stake Pool Operator Verification Key", cold.vkey));
    writeTextEnvelope(file("node.counter"), encodeIssueCounter({ next: 0n, coldVkey: cold.vkey }));
    writeTextEnvelope(file("kes.skey"), envelopeOfBytes(EnvelopeType.kesSigningKey, "KES Signing Key", kesSecretForEnvelope(kes)));
    writeTextEnvelope(file("kes.vkey"), envelopeOfBytes(EnvelopeType.kesVerificationKey, "KES Verification Key", kes.vkey));
    writeTextEnvelope(file("vrf.skey"), envelopeOfBytes(EnvelopeType.vrfSigningKey, "VRF Signing Key", vrf.skey));
    writeTextEnvelope(file("vrf.vkey"), envelopeOfBytes(EnvelopeType.vrfVerificationKey, "VRF Verification Key", vrf.vkey));
    const pay = generateKeyPair(), stake = generateKeyPair();
    const pe = keyEnvelopes("payment", pay), se = keyEnvelopes("stake", stake);
    writeTextEnvelope(file("payment.skey"), pe.skey); writeTextEnvelope(file("payment.vkey"), pe.vkey);
    writeTextEnvelope(file("stake.skey"), se.skey); writeTextEnvelope(file("stake.vkey"), se.vkey);
    const addr = addressBech32(baseAddressBytes(networkId, keyHash(pay.vkey), keyHash(stake.vkey)));
    const saddr = addressBech32(stakeAddressBytes(networkId, keyHash(stake.vkey)));
    writeFileSync(file("payment.addr"), addr); writeFileSync(file("stake.addr"), saddr);
    console.log(`pool id      ${poolIdOf(cold.vkey)}\nvrf key hash ${vrfKeyHashOf(vrf.vkey)}\npayment addr ${addr}\nstake addr   ${saddr}\nkeys written to ${dir} (mode 0600). Fund the payment address, then run opcert and register.`);
} else if (cmd === "opcert") {
    const { tipSlot, genesis } = await tipAndParams();
    const cold = loadColdSigningKey(file("cold.skey"));
    const kes = loadKesSigningKey(file("kes.skey"), file("kes.vkey"));
    const counter = readIssueCounter(file("node.counter"));
    const period = kesPeriodOfSlot(tipSlot, BigInt(genesis.slotsPerKESPeriod));
    const { opcert, nextCounter } = issueOperationalCert(kes.vkey, counter, period, cold);
    writeTextEnvelope(file("node.cert"), encodeOperationalCert(opcert));
    writeTextEnvelope(file("node.counter"), encodeIssueCounter(nextCounter));
    console.log(`node.cert issued: counter ${opcert.cert.counter}, KES period ${period} (tip slot ${tipSlot}); node.counter now ${nextCounter.next}`);
} else if (cmd === "register") {
    const { tipSlot, epoch, params, network } = await tipAndParams();
    const pay = loadSigningKey(file("payment.skey"), KeyEnvelopeType.paymentSigning);
    const stake = loadSigningKey(file("stake.skey"), KeyEnvelopeType.stakeSigning);
    const cold = loadColdSigningKey(file("cold.skey"));
    const vrf = loadVrfSigningKey(file("vrf.skey"));
    const addrText = readFileSync(file("payment.addr"), "utf8").trim();
    const addr = bech32Decode(addrText).bytes;
    const stakeHash = keyHash(stake.vkey);
    const poolId = Uint8Array.from(Buffer.from(poolIdOf(cold.vkey), "hex"));
    const keyDeposit = BigInt(params.key_deposit), poolDeposit = BigInt(params.pool_deposit);
    const minPoolCost = BigInt(params.min_pool_cost);
    const cost = BigInt(need("cost"));
    if (cost < minPoolCost) { console.error(`--cost ${cost} is below min_pool_cost ${minPoolCost}`); process.exit(1); }
    const relays: Relay[] = (args.relay ?? []).map((r) => {
        const [host, port] = r.split(":");
        return /^\d+\.\d+\.\d+\.\d+$/.test(host!) ? { type: "single-host-addr", ipv4: host, port: port ? Number(port) : undefined } : { type: "single-host-name", dnsName: host!, port: port ? Number(port) : undefined };
    });
    if (!relays.length) { console.error("at least one --relay host:port"); process.exit(2); }
    let metadata: { url: string; hash: Uint8Array } | null = null;
    if (arg("metadata-url")) metadata = { url: arg("metadata-url")!, hash: poolMetadataHash(new Uint8Array(readFileSync(need("metadata-file")))) };
    const certs: CborArray[] = [];
    const skipStakeReg = arg("skip-stake-reg") === "true";
    if (!skipStakeReg) certs.push(stakeRegistrationCert(stakeHash, keyDeposit));
    certs.push(poolRegistrationCert({
        operator: poolId, vrfKeyHash: Uint8Array.from(Buffer.from(vrfKeyHashOf(vrf.vkey), "hex")), pledge: BigInt(need("pledge")), cost,
        margin: marginFromDecimal(arg("margin", "0")!), rewardAccount: stakeAddressBytes(networkId, stakeHash), owners: [stakeHash], relays, metadata,
    }));
    certs.push(stakeDelegationCert(stakeHash, poolId));
    // inputs: every lovelace-only UTxO at the payment address
    const utxos = await nodeJson<Array<{ tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> }>>(`/api/v0/addresses/${encodeURIComponent(addrText)}/utxos`);
    const usable = utxos.filter((u) => u.amount.every((a) => a.unit === "lovelace"));
    const total = usable.reduce((s, u) => s + BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"), 0n);
    const deposits = (skipStakeReg ? 0n : keyDeposit) + poolDeposit;
    if (!usable.length || total <= deposits) { console.error(`payment address holds ${total} lovelace in ${usable.length} UTxO(s); needs more than the deposits ${deposits} plus fee. Fund ${addrText}`); process.exit(1); }
    const built = buildWithMinFee({
        inputs: usable.map((u) => ({ txHash: Uint8Array.from(Buffer.from(u.tx_hash, "hex")), index: u.output_index })),
        outputs: [{ address: addr, lovelace: total - deposits }], changeIndex: 0,
        ttl: tipSlot + BigInt(arg("ttl", "7200")!), certificates: certs,
        minFeeA: BigInt(params.min_fee_a), minFeeB: BigInt(params.min_fee_b), keys: [pay, stake, cold],
    });
    writeTextEnvelope(file("tx.signed"), txEnvelope(built.tx));
    for (const [i, c] of certs.entries()) writeTextEnvelope(file(`cert-${i}.cert`), certificateEnvelope(c));
    const id = Buffer.from(txId(built.body)).toString("hex");
    console.log(`network ${network} epoch ${epoch} tip ${tipSlot}\npool ${Buffer.from(poolId).toString("hex")}\ninputs ${usable.length} (${total} lovelace), deposits ${deposits}, fee ${built.fee}, change ${total - deposits - built.fee}\ncertificates: ${skipStakeReg ? "" : "stake registration, "}pool registration, delegation\ntx id ${id}\ntx.signed written (${built.tx.length} bytes)`);
    if (arg("submit") === "true") {
        const base = need("node").replace(/\/$/, "");
        const r = await fetch(base + "/txsubmit", { method: "POST", headers: { "Content-Type": "application/cbor" }, body: built.tx });
        console.log(`submit: HTTP ${r.status} ${await r.text()}`);
    } else {
        console.log(`not submitted (add --submit), or: curl -X POST --data-binary @<(python3 -c "import json,sys;sys.stdout.buffer.write(bytes.fromhex(json.load(open('${file("tx.signed")}'))['cborHex']))") ${need("node")}/txsubmit`);
    }
} else {
    console.error("usage: keygen | opcert | register (see file header)"); process.exit(2);
}
