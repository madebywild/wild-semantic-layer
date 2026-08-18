import type { SQLInputValue } from "node:sqlite";
import type { SqliteConnection } from "./connection.js";

export function sqlRows(
  conn: SqliteConnection,
  statement: string,
  params?: Record<string, SQLInputValue>,
): Record<string, unknown>[] {
  const prepared = conn.prepare(statement);
  return (params ? prepared.all(params) : prepared.all()) as Record<string, unknown>[];
}

export function sqlCount(
  conn: SqliteConnection,
  statement: string,
  column: string,
  params?: Record<string, SQLInputValue>,
): number {
  return Number(sqlRows(conn, statement, params)[0]?.[column] ?? 0);
}
