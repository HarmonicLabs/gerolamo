/**
 * Byte-compare the hard-fork history (GetInterpreter, GetCurrentEra) we compute with a
 * cardano-node's, over its N2C socket (read-only queries).
 *
 *   bun scripts/hfc-compare.ts --socket <node.socket> --magic 2 --shelley src/config/preview/shelley-genesis.json \
 *       --byron src/config/preview/byron-genesis.json [--network preview] [--block-store <node dir>/db] [--k 432]
 *
 * Era starts come from (in order) the Test* triggers, the block store scan (when given, opened
 * read-only) and the built-in history; the reference node's own ledger tip is used as ours.
 */
import { Cbor, CborArray, CborUInt, CborBytes } from "@harmoniclabs/cbor";
import { openLsq } from "./lib/lsq";
import { createHardForkHistory, resolveEraStarts } from "../src/consensus/hfc/hfcNode";
import { encodeInterpreter, HFC_ERAS } from "../src/consensus/hfc/hfc";
import { BlockStore } from "../src/storage/blockStore";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const sock = arg("socket")!, magic = Number(arg("magic") ?? 2);
const hex = (o: any) => Buffer.from(Cbor.encode(o).toBuffer()).toString("hex");
const c = await openLsq(sock, magic);
const point = await c.query(new CborArray([new CborUInt(3)])) as CborArray; // GetChainPoint → [slot, hash]
const tipSlot = (point.array[0] as CborUInt).num;
const relayInterp = hex(await c.query(new CborArray([new CborUInt(0), new CborArray([new CborUInt(2), new CborArray([new CborUInt(0)])])])));
const relayEra = Number(((await c.query(new CborArray([new CborUInt(0), new CborArray([new CborUInt(2), new CborArray([new CborUInt(1)])])]))) as CborUInt).num);
c.close();

const h = createHardForkHistory({ network: arg("network"), networkMagic: magic, shelleyGenesisFile: arg("shelley")!, byronGenesisFile: arg("byron") });
const bsDir = arg("block-store");
const store = bsDir ? await BlockStore.open(bsDir, { k: Number(arg("k") ?? 432), readOnly: true }) : null;
await resolveEraStarts(h, { store, tipSlot, tipEra: relayEra });
const ours = hex(encodeInterpreter(h.summary(tipSlot)));
console.log(`relay tip slot ${tipSlot}, era ${HFC_ERAS[relayEra]}; our era ${HFC_ERAS[h.currentEra()]}; starts ${h.startEpochs().map((e, i) => `${HFC_ERAS[i]}@${e}(${h.sourceOf(i)})`).join(", ")}`);
console.log(`GetCurrentEra: ${relayEra === h.currentEra() ? "IDENTICAL" : `DIFFERENT (relay ${relayEra}, ours ${h.currentEra()})`}`);
console.log(`GetInterpreter: ${ours === relayInterp ? "IDENTICAL" : "DIFFERENT"} (${relayInterp.length / 2} bytes)`);
if (ours !== relayInterp || process.argv.includes("--print")) { console.log(`relay ${relayInterp}`); console.log(`ours  ${ours}`); }

process.exit(ours === relayInterp && relayEra === h.currentEra() ? 0 : 1);
