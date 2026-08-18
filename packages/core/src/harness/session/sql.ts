/**
 * Tagged-template SQL helper, ported from pi (earendil-works) and adapted to
 * node:sqlite.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/session-backends/sqlite-node/src/sqlite/sql.ts
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export type SqliteValue = string | number | null;

type SqlTemplateValue = SqliteValue | SqlQuery;

/** A parameterized SQLite query produced by {@link sql}. */
export class SqlQuery {
  readonly queryText: string;
  readonly params: readonly SqliteValue[];

  constructor(queryText: string, params: readonly SqliteValue[] = []) {
    this.queryText = queryText;
    this.params = params;
  }

  run(db: DatabaseSync): ReturnType<StatementSync["run"]> {
    return db.prepare(this.queryText).run(...this.params);
  }

  get<TRow extends object>(db: DatabaseSync): TRow | undefined {
    return db.prepare(this.queryText).get(...this.params) as TRow | undefined;
  }

  all<TRow extends object>(db: DatabaseSync): TRow[] {
    return db.prepare(this.queryText).all(...this.params) as TRow[];
  }
}

/** Builds a parameterized query. Nested queries are inlined; other interpolations become `?` parameters. */
export function sql(strings: TemplateStringsArray, ...values: SqlTemplateValue[]): SqlQuery {
  let queryText = strings[0] ?? "";
  const params: SqliteValue[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value instanceof SqlQuery) {
      queryText += value.queryText;
      params.push(...value.params);
    } else {
      queryText += "?";
      params.push(value ?? null);
    }
    queryText += strings[index + 1] ?? "";
  }
  return new SqlQuery(queryText, params);
}

/** Joins trusted query fragments while preserving their parameter order. */
export function joinSqlFragments(fragments: readonly SqlQuery[], separator: string): SqlQuery {
  let queryText = "";
  const params: SqliteValue[] = [];
  for (let index = 0; index < fragments.length; index++) {
    if (index > 0) queryText += separator;
    const fragment = fragments[index]!;
    queryText += fragment.queryText;
    params.push(...fragment.params);
  }
  return new SqlQuery(queryText, params);
}
