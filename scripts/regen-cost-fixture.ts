/**
 * Regenerates the builtin cost fixture from the installed plutus-machine.
 * Usage: bun scripts/regen-cost-fixture.ts
 * The fixture is checked against the reference evaluator in plutusCostModel.test.ts;
 * values are re-baselined only when the vendored machine changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Machine } from "@harmoniclabs/plutus-machine";
import { Application, Builtin, UPLCBuiltinTag, UPLCConst } from "@harmoniclabs/uplc";
import { toCostModelV1, toCostModelV2 } from "@harmoniclabs/cardano-costmodels-ts";

const fixturePath = "src/consensus/__fixtures__/plutus-integer-builtin-reference.json";
const costModels = JSON.parse(readFileSync("src/consensus/__fixtures__/preview-costmodels-736.json", "utf8")) as Record<string, number[]>;
const machines = {
    v1: new Machine(toCostModelV1(costModels.PlutusV1 as any) as any),
    v2: new Machine(toCostModelV2(costModels.PlutusV2 as any) as any),
    v3: new Machine(costModels.PlutusV3 as any),
};
const rows = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{ lang: "v1" | "v2" | "v3"; builtin: string; x: string | number; y: string | number; sizes: number[]; cpu: number; mem: number }>;
for (const r of rows) {
    const term = new Application(new Application(new Builtin((UPLCBuiltinTag as any)[r.builtin]), UPLCConst.int(BigInt(r.x))), UPLCConst.int(BigInt(r.y)));
    const { budgetSpent } = machines[r.lang].eval(term);
    r.cpu = Number(budgetSpent.cpu);
    r.mem = Number(budgetSpent.mem);
}
writeFileSync(fixturePath, JSON.stringify(rows, null, 0) + "\n");
console.log(`regenerated ${rows.length} builtin reference rows`);
