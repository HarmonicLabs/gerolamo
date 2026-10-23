/**
 * A small JSON Schema (draft 2020-12) checker for the node-diversity-conformance report schemas:
 * the keywords they use — type (incl. type lists and "integer"), const, enum (a 4 000-entry
 * enumeration is turned into a set once), required, properties, additionalProperties (false, or a
 * schema) at any level, items, $ref to "#/$defs/…", oneOf (an alternative list of consts is
 * reported as one "not one of" message), minimum, pattern and format "date-time". Unknown
 * keywords are ignored. Returns the violations as "path: message".
 */
type Schema = Record<string, any> | boolean;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const enumSets = new WeakMap<object, Set<string>>();

function typeOk(t: string, v: unknown): boolean {
    switch (t) {
        case "null": return v === null;
        case "boolean": return typeof v === "boolean";
        case "string": return typeof v === "string";
        case "number": return typeof v === "number" && Number.isFinite(v);
        case "integer": return typeof v === "number" && Number.isInteger(v);
        case "array": return Array.isArray(v);
        case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    }
    return false;
}
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const short = (v: unknown) => { const s = JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 77)}…` : s; };

export function checkSchema(schema: Schema, value: unknown, root: Schema = schema, path = "$"): string[] {
    if (schema === true) return [];
    if (schema === false) return [`${path}: not allowed`];
    const errs: string[] = [];
    if (schema.$ref) {
        const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
        const target = m && typeof root === "object" ? root.$defs?.[m[1]!] : undefined;
        if (target === undefined) return [`${path}: unresolved $ref ${schema.$ref}`];
        errs.push(...checkSchema(target, value, root, path));
    }
    if (schema.type !== undefined) {
        const ts: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!ts.some((t) => typeOk(t, value))) return [...errs, `${path}: expected ${ts.join(" | ")}, got ${kindOf(value)}`];
    }
    if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${short(value)}`);
    if (Array.isArray(schema.enum)) {
        let set = enumSets.get(schema.enum);
        if (!set) { set = new Set(schema.enum.map((e: unknown) => JSON.stringify(e))); enumSets.set(schema.enum, set); }
        if (!set.has(JSON.stringify(value))) errs.push(`${path}: ${short(value)} is not one of the ${set.size} enumerated values${set.size <= 8 ? ` ${JSON.stringify(schema.enum)}` : ""}`);
    }
    if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof value === "string" && schema.format === "date-time" && !DATE_TIME.test(value)) errs.push(`${path}: not an RFC 3339 date-time`);
    if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errs.push(`${path}: ${short(value)} does not match /${schema.pattern}/`);
    if (Array.isArray(schema.oneOf)) {
        const alts = schema.oneOf as Schema[];
        const n = alts.filter((s) => checkSchema(s, value, root, path).length === 0).length;
        if (n !== 1) {
            const consts = alts.every((s) => typeof s === "object" && "const" in s && Object.keys(s).length === 1);
            errs.push(consts ? `${path}: ${short(value)} is not one of the ${alts.length} allowed constants` : `${path}: matches ${n} of the oneOf alternatives`);
        }
    }
    if (typeOk("object", value)) {
        const o = value as Record<string, unknown>;
        for (const k of schema.required ?? []) if (!(k in o)) errs.push(`${path}: missing ${k}`);
        const props = schema.properties ?? {};
        for (const [k, v] of Object.entries(o)) {
            if (k in props) errs.push(...checkSchema(props[k], v, root, `${path}.${k}`));
            else if (schema.additionalProperties === false) errs.push(`${path}: unexpected property ${k}`);
            else if (typeof schema.additionalProperties === "object") errs.push(...checkSchema(schema.additionalProperties, v, root, `${path}.${k}`));
        }
    }
    if (Array.isArray(value) && schema.items !== undefined) value.forEach((x, i) => errs.push(...checkSchema(schema.items, x, root, `${path}[${i}]`)));
    return errs;
}
