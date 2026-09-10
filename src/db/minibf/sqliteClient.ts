/**
 * A tagged-template client over `bun:sqlite` with the surface the mb_* writer and schema
 * use (`await db\`…\``, `.values()`, `.unsafe()`), so the explorer worker and the backfill
 * script can drive the same writer code as the Bun.SQL path.
 */
import type { Database } from "bun:sqlite";
import type { MbSql } from "./schema";

export function sqliteClient(d: Database): MbSql {
    const run = (strings: TemplateStringsArray, values: unknown[]) => {
        const q = strings.join("?");
        const params = values.map((v) => (typeof v === "bigint" ? v.toString() : v)) as any[];
        const stmt = d.query(q);
        const p = Promise.resolve(stmt.all(...params));
        return Object.assign(p, { values: () => Promise.resolve(stmt.values(...params)) });
    };
    const tag: any = (strings: TemplateStringsArray, ...values: unknown[]) => run(strings, values);
    tag.unsafe = (q: string) => Promise.resolve(d.run(q));
    tag.exec = (q: string) => Promise.resolve(d.run(q));
    return tag as MbSql;
}
