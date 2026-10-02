#!/usr/bin/env bun
/** Trim a dumped replay job (plutus-replay.ts --dump-dir) into a test fixture: params reduced to the cost models and protocol version.
 *   bun scripts/plutus-fixture.ts <job.json> <out.json> */
import { readFileSync, writeFileSync } from "node:fs";
const job = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const p = job.params ?? {};
job.params = { cost_models: p.cost_models, protocol_major_ver: p.protocol_major_ver, protocol_minor_ver: p.protocol_minor_ver };
writeFileSync(process.argv[3]!, JSON.stringify(job) + "\n");
