import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../types.js";
import { getPool, installExitHook, type PooledDatabase } from "./pool.js";
import { clearSearchCache } from "./queries/cache.js";

export type SqliteConnection = DatabaseSync;

export function dbFileForConfig(config: ResolvedConfig): string {
  return resolve(config.vaultDir, ".semantic-layer", "vault.sqlite");
}

/** Legacy LadybugDB artifacts are deliberately never removed by migration. */
export function legacyIndexArtifacts(config: ResolvedConfig): string[] {
  const legacy = resolve(config.vaultDir, ".semantic-layer", "vault.lbug");
  return [
    legacy,
    `${legacy}.wal`,
    `${legacy}.wal.checkpoint`,
    `${legacy}.meta.json`,
    `${legacy}.meta.json.tmp`,
  ].filter(existsSync);
}

export function openDatabase(dbPath: string): SqliteConnection {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  try {
    db.exec("CREATE VIRTUAL TABLE temp.semantic_layer_fts5_probe USING fts5(content)");
    db.exec("DROP TABLE temp.semantic_layer_fts5_probe");
  } catch (error) {
    db.close();
    throw new Error(
      "semantic-layer: the active SQLite runtime does not provide FTS5, which the search index requires.",
      { cause: error },
    );
  }
  return db;
}

export function isCorruptionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate?.code ?? "");
  const message = String(candidate?.message ?? error ?? "");
  return (
    /SQLITE_(?:CORRUPT(?:_VTAB)?|NOTADB)/i.test(code) ||
    /database disk image is malformed|file is not a database|malformed database schema/i.test(
      message,
    )
  );
}

/** Quarantines every SQLite artifact only for corruption-class derived-state recovery. */
export function quarantineDatabaseArtifacts(dbPath: string): string[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (!existsSync(source)) continue;
    const target = `${source}.corrupt-${stamp}`;
    renameSync(source, target);
    moved.push(target);
  }
  return moved;
}

function acquireDatabaseLocked(path: string): SqliteConnection {
  const pool = getPool();
  if (pool.current?.path === path) return pool.current.db;
  if (pool.current) {
    clearSearchCache(pool.current.path);
    pool.current.db.close();
    pool.current = undefined;
  }
  const db = openDatabase(path);
  // A reopened handle starts a fresh PRAGMA data_version counter baseline, so an old cache value
  // must not be reused after a path switch or an external writer ran while it was closed.
  clearSearchCache(path);
  pool.current = { path, db } satisfies PooledDatabase;
  installExitHook();
  return db;
}

/** Releases the pooled handle before its files are quarantined or removed externally. */
export function discardPooledDatabase(dbPath: string): void {
  const pool = getPool();
  const path = resolve(dbPath);
  if (pool.current?.path !== path) return;
  clearSearchCache(path);
  try {
    pool.current.db.close();
  } catch {
    // A corrupt SQLite handle may refuse to close cleanly.
  }
  pool.current = undefined;
}

function quarantineDatabaseLocked(dbPath: string): string[] {
  discardPooledDatabase(dbPath);
  return quarantineDatabaseArtifacts(dbPath);
}

/**
 * Explicit derived-index recovery hook for the builder/search layer. Call it only after
 * `isCorruptionError` returns true; regular read commands must surface their original error.
 */
export async function recoverCorruptIndex(config: ResolvedConfig): Promise<string[]> {
  const dbPath = dbFileForConfig(config);
  const pool = getPool();
  const run = pool.workLock.then(() => quarantineDatabaseLocked(dbPath));
  pool.workLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const reentrancyGuard = new AsyncLocalStorage<boolean>();

export async function withConnection<T>(
  dbPath: string,
  fn: (conn: SqliteConnection) => Promise<T> | T,
): Promise<T> {
  if (reentrancyGuard.getStore()) {
    throw new Error("withConnection must not be nested; pass the active SQLite connection down.");
  }
  const pool = getPool();
  const run = pool.workLock.then(async () => {
    const path = resolve(dbPath);
    const db = acquireDatabaseLocked(path);
    try {
      return await reentrancyGuard.run(true, () => fn(db));
    } catch (error) {
      // Quarantine while this unit still owns the work lock. The original error propagates and
      // callers decide whether their command is allowed to trigger a full rebuild.
      if (isCorruptionError(error)) quarantineDatabaseLocked(path);
      throw error;
    }
  });
  pool.workLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function withConnectionForConfig<T>(
  config: ResolvedConfig,
  fn: (conn: SqliteConnection) => Promise<T> | T,
): Promise<T> {
  return withConnection(dbFileForConfig(config), fn);
}
