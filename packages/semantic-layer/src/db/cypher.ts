import type { Connection, LbugValue, QueryResult } from "@ladybugdb/core";

/**
 * Runs a Cypher statement and returns all rows. LadybugDB may answer a query with an array of
 * results (one per statement for multi-statement inputs); every caller in this package issues
 * exactly one statement, so an array with anything but one entry is a programming error.
 */
export async function queryRows(
  conn: Connection,
  statement: string,
  params?: Record<string, LbugValue>,
): Promise<Record<string, unknown>[]> {
  const result = params
    ? await conn.execute(await conn.prepare(statement), params)
    : await conn.query(statement);
  const single = Array.isArray(result) ? result[0] : result;
  if (!single) throw new Error(`Expected a single query result for: ${statement}`);
  return (await (single as QueryResult).getAll()) as Record<string, unknown>[];
}

/** Reads a single numeric column from a single-row result (e.g. `RETURN count(n) AS cnt`). */
export async function queryCount(
  conn: Connection,
  statement: string,
  column: string,
): Promise<number> {
  const rows = await queryRows(conn, statement);
  return Number(rows[0]?.[column] ?? 0);
}
