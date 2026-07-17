import { Connection, Database } from "@ladybugdb/core";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedConfig } from "../types.js";
import { createSchema } from "./schema.js";

const DEFAULT_MAX_DB_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Path of the vault's LadybugDB file; the single source of truth for every command. */
export function dbFileForConfig(config: ResolvedConfig): string {
  return resolve(config.vaultDir, ".semantic-layer", "vault.lbug");
}

export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  // bufferManagerSize 0 = library default, compression on, read-write.
  const db = new Database(dbPath, 0, true, false, DEFAULT_MAX_DB_SIZE_BYTES);
  db.initSync();
  return db;
}

export function closeConnection(conn: Connection): void {
  conn.closeSync();
}

export function closeDatabase(db: Database): void {
  db.closeSync();
}

/**
 * Retries the transient WAL-checkpoint race documented below; all other errors fail immediately.
 * The `open` seam exists so tests can drive the retry policy without the native module.
 */
export async function openDatabaseWithRetry(
  dbPath: string,
  retries = 20,
  retryDelayMs = 50,
  open: (dbPath: string) => Database = openDatabase,
): Promise<Database> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return open(dbPath);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // LadybugDB 0.18.2's native close can return before its WAL checkpoint thread finishes;
      // the next open may race on renaming the WAL file. Retry only that transient race.
      if (!/wal|checkpoint|renaming/i.test(message)) throw error;
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

export async function withConnection<T>(
  dbPath: string,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const db = await openDatabaseWithRetry(dbPath);
  const conn = new Connection(db);
  await conn.init();
  try {
    await createSchema(conn);
    return await fn(conn);
  } finally {
    // Synchronous close is required for clean process shutdown: LadybugDB 0.18.2's async close
    // resolves before native background threads have fully released their mutexes, which causes
    // an abort-on-exit in long-running processes like the CLI.
    try {
      conn.closeSync();
    } catch {
      // Best-effort connection close.
    }
    try {
      db.closeSync();
    } catch {
      // Best-effort database close.
    }
    // LadybugDB 0.18.2's native close can return before the WAL checkpoint thread has finished.
    // Tests that immediately reopen the same database in the same process are protected by
    // reusing a single connection; this delay is a safety margin for any other rapid cycle.
    await delay(100);
  }
}

export function withConnectionForConfig<T>(
  config: ResolvedConfig,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  return withConnection(dbFileForConfig(config), fn);
}
