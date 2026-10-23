#!/usr/bin/env bun
/**
 * Check node-diversity-conformance reports against a scenario schema (src/conformance/ndc/uplcSchemaCheck.ts).
 *   bun scripts/ndc/uplc-validate-report.ts <schema.json> <report.json> [<report.json> …]
 * Exits 1 when any report has a violation; a report must also declare `version: "1"` and the schema's scenario.
 */
import { readFileSync } from "node:fs";
import { checkSchema } from "../../src/conformance/ndc/uplcSchemaCheck";

const [schemaPath, ...reportPaths] = process.argv.slice(2);
if (!schemaPath || reportPaths.length === 0) { console.error("usage: uplc-validate-report.ts <schema.json> <report.json> [<report.json> …]"); process.exit(2); }
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const scenario: string | undefined = schema?.properties?.scenario?.const;
let bad = 0;
for (const reportPath of reportPaths) {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const errs = checkSchema(schema, report);
    if (scenario && report?.scenario !== scenario) errs.push(`$.scenario: ${JSON.stringify(report?.scenario)} is not ${JSON.stringify(scenario)}`);
    if (errs.length) { bad++; for (const e of errs.slice(0, 50)) console.error(`${reportPath}: ${e}`); console.error(`${reportPath}: ${errs.length} violation(s)`); }
    else console.log(`${reportPath}: valid against ${schemaPath}`);
}
process.exit(bad ? 1 : 0);
