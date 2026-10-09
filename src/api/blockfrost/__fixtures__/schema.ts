/**
 * A JSON-schema validator for the subset Blockfrost's response schemas use (type, nullable,
 * properties, required, items, enum, anyOf / oneOf, additionalProperties, minLength / maxLength,
 * maximum). Returns the violations; an empty list means the value matches.
 */
import vendored from "../blockfrost-openapi.responses.json";

export const SCHEMAS = (vendored as { paths: Record<string, any> }).paths;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function validate(schema: any, v: unknown, at = "$"): string[] {
    if (!schema || typeof schema !== "object") return [];
    if (v === null) return schema.nullable || schema.type === "null" || (schema.anyOf ?? schema.oneOf)?.some((s: any) => s.nullable || s.type === "null") || (schema.type == null && !schema.anyOf && !schema.oneOf) ? [] : [`${at}: null not allowed`];
    const alts = schema.anyOf ?? schema.oneOf;
    if (alts) {
        const errs = alts.map((s: any) => validate(s, v, at));
        return errs.some((e: string[]) => e.length === 0) ? [] : [`${at}: matches none of ${alts.length} alternatives (${errs.map((e: string[]) => e[0]).join(" | ")})`];
    }
    const out: string[] = [];
    const t = typeOf(v);
    if (schema.type) {
        const ok = schema.type === t || (schema.type === "number" && (t === "integer" || t === "number")) || (schema.type === "integer" && t === "integer");
        if (!ok) return [`${at}: expected ${schema.type}, got ${t}`];
    }
    if (schema.enum && !schema.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(schema.enum)}`);
    if (typeof v === "string") {
        if (schema.minLength != null && v.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
        if (schema.maxLength != null && v.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
    }
    if (typeof v === "number" && schema.maximum != null && v > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
    if (t === "array" && schema.items) (v as unknown[]).forEach((x, i) => out.push(...validate(schema.items, x, `${at}[${i}]`)));
    if (t === "object") {
        const o = v as Record<string, unknown>;
        for (const r of schema.required ?? []) if (!(r in o)) out.push(`${at}.${r}: missing`);
        for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o && o[k] !== undefined) out.push(...validate(s, o[k], `${at}.${k}`));
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") for (const [k, x] of Object.entries(o)) if (!(k in (schema.properties ?? {}))) out.push(...validate(schema.additionalProperties, x, `${at}.${k}`));
    }
    return out;
}
