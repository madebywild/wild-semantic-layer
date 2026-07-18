import { Connection, Database } from "@ladybugdb/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedConfig } from "../types.js";
import { getPool, installExitHook, type PooledDatabase } from "./pool.js";
import { createSchema } from "./schema.js";

const DEFAULT_MAX_DB_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB
/**
 * LadybugDB's default buffer pool claims ~80% of system RAM. A library must not do that — and on
 * smaller machines the claim plus a resident embedding runtime (1-3 GB of ONNX arena) pressures
 * the OS allocator hard enough that frame allocation in the checkpoint path fails natively
 * (segfault in BufferManager::claimAFrame, observed after a 5k-note build on a 16 GB host).
 * 2 GiB is ample for bulk index builds far beyond vault scale while leaving headroom for the
 * embedder and the host OS.
 */
const BUFFER_MANAGER_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Path of the vault's LadybugDB file; the single source of truth for every command. */
export function dbFileForConfig(config: ResolvedConfig): string {
  return resolve(config.vaultDir, ".semantic-layer", "vault.lbug");
}

export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  // compression on, read-write; buffer pool capped (see above) instead of the 80%-of-RAM default.
  const db = new Database(
    dbPath,
    BUFFER_MANAGER_SIZE_BYTES,
    true,
    false,
    DEFAULT_MAX_DB_SIZE_BYTES,
  );
  db.initSync();
  return db;
}

/**
 * Retries the transient WAL-checkpoint race documented below; all other errors fail immediately.
 * The `open` seam exists so tests can drive the retry policy without the native module.
 * A WAL file whose main database file is gone is unrecoverable crash debris (e.g. the .lbug was
 * deleted mid-crash): the open can never succeed against it, so it is removed and retried fresh.
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
      if (!existsSync(dbPath)) {
        for (const suffix of [".wal", ".wal.checkpoint"]) {
          rmSync(`${dbPath}${suffix}`, { force: true });
        }
      }
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

/**
 * Process-wide single-slot database pool.
 *
 * LadybugDB 0.18.2's native close leaves background state behind: after a Database on path P is
 * closed, a NEW Database opened on the same P in the same process can fail its checkpoint-forcing
 * statements (CREATE_FTS_INDEX and friends rename `.wal` to `.wal.checkpoint` internally) with
 * "IO exception: Error renaming file ... No such file or directory". Worse, a CREATE_FTS_INDEX
 * that fails this way is not rolled back cleanly — it leaves orphaned internal FTS tables
 * (`0_..._appears_info`) that make any retry fail with "already exists". Empirically (see the
 * pinning test in tests/integration/db/connection.test.ts):
 *   - close-then-reopen the SAME path in-process: races in ~2-4 of 6 heavy rebuild cycles;
 *   - one shared Database for repeated builds: 0 failures;
 *   - closing a Database on a DIFFERENT path before opening a new one: 0 failures.
 * The pool therefore keeps the most recently used Database open for the process lifetime and
 * reuses it for every withConnection call on that path. Switching paths closes the previous
 * handle (cross-path close is safe). The one unsafe case — the pooled file was deleted on disk,
 * so the path must be re-opened — retires the stale handle to a graveyard WITHOUT closing it;
 * everything is closed synchronously in a process exit hook.
 */
async function acquireDatabaseLocked(key: string): Promise<Database> {
  const pool = getPool();
  const current = pool.current;
  if (current && current.path === key) {
    if (existsSync(key)) return current.db;
    // The database file was deleted out from under the pooled handle (e.g. a forced reset).
    // Closing the stale handle would poison the fresh open on this same path, so retire it
    // unclosed; the exit hook cleans it up.
    pool.graveyard.push(current.db);
    pool.current = undefined;
  } else if (current) {
    // Path switch: closing a database on a different path is safe for the new one, and the
    // work lock guarantees nothing is using the old handle anymore.
    try {
      current.db.closeSync();
    } catch {
      // Best-effort close of the evicted database.
    }
    pool.current = undefined;
  }

  const db = await openDatabaseWithRetry(key);
  const entry: PooledDatabase = { path: key, db };
  pool.current = entry;
  installExitHook();
  return db;
}

// Turns the silent deadlock of a nested withConnection call (awaiting the lock its own caller
// holds) into an immediate, explanatory error. Module-scoped, so it only guards nesting within
// one copy of this module — the common case; cross-copy nesting still deadlocks.
const reentrancyGuard = new AsyncLocalStorage<boolean>();

/**
 * Runs `fn` against the pooled database for `dbPath`. The entire unit of work is serialized
 * through the pool's work lock — see the lock's doc in pool.ts (check-then-act acquire, and
 * LadybugDB's one-write-transaction-per-system rule). Consequently `fn` must never call
 * withConnection itself; nested calls throw. Reuse the outer connection instead (the pattern
 * `querySearch(..., { connection })` and `buildIndexWithConnection` exist for).
 */
export async function withConnection<T>(
  dbPath: string,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  if (reentrancyGuard.getStore()) {
    throw new Error(
      "withConnection must not be nested: units of work are serialized process-wide, so a " +
        "nested call would deadlock. Pass the outer connection down instead.",
    );
  }
  const pool = getPool();
  const run = pool.workLock.then(() =>
    reentrancyGuard.run(true, () => withConnectionLocked(resolve(dbPath), fn)),
  );
  // The lock must survive a failed unit of work; park the rejection so the chain stays usable
  // (the caller still receives it through `run`).
  pool.workLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withConnectionLocked<T>(
  key: string,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const db = await acquireDatabaseLocked(key);
  const conn = new Connection(db);
  await conn.init();
  try {
    await createSchema(conn);
    return await fn(conn);
  } finally {
    // Drain the WAL only when this unit of work actually wrote: a read-only unit leaves the
    // WAL empty, and every CHECKPOINT is a chance to hit LadybugDB 0.18.2's checkpoint race
    // (SIGSEGV in BufferManager::claimAFrame via writeDatabaseHeaderToStorage, reproduced
    // repeatedly with a native embedding runtime resident — it fires on worker threads under
    // thread contention, and a crashed finishCheckpoint corrupts the database header).
    // Skipping no-op drains removes the race window from pure query workloads; write units
    // still drain so the on-disk file stays complete for out-of-process readers.
    try {
      const walPath = `${key}.wal`;
      if (existsSync(walPath) && statSync(walPath).size > 0) {
        await conn.query("CHECKPOINT");
      }
    } catch {
      // Best-effort drain (e.g. the callback broke the connection).
    }
    try {
      conn.closeSync();
    } catch {
      // Best-effort connection close.
    }
  }
}

export function withConnectionForConfig<T>(
  config: ResolvedConfig,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  return withConnection(dbFileForConfig(config), fn);
}
