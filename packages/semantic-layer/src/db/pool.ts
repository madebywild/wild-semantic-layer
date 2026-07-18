import type { Database } from "@ladybugdb/core";

/**
 * Process-wide single-slot database pool state. Kept in a module that only type-imports
 * `@ladybugdb/core`, so `closePooledDatabases` can be exported from the package index without
 * loading the native module on platforms that don't have it (musl/Alpine) — closing an empty
 * pool must stay a no-op there. See `connection.ts` for why the pool exists.
 */
export type PooledDatabase = { path: string; db: Database };

type DatabasePool = {
  current: PooledDatabase | undefined;
  /** Handles that must outlive their eviction unclosed; closed only at process exit. */
  graveyard: Database[];
  /**
   * Serializes entire units of work, not just acquisition. Two reasons: the pool's acquire is
   * check-then-act across an await (overlapping acquires on one path would both open the file —
   * reproducing the same-path WAL race — and on different paths would leak a handle), and
   * LadybugDB itself allows only one write transaction system-wide, so concurrent callbacks on
   * the shared handle fail with "Only one write transaction at a time". Lives on the pool so
   * every module copy in the process serializes against the same lock.
   */
  workLock: Promise<unknown>;
  exitHookInstalled: boolean;
};

// Keyed on globalThis so every copy of this module in one process (e.g. vitest re-importing per
// test file) shares one pool — two pools would reintroduce the same-path close-then-reopen race.
const POOL_KEY = Symbol.for("@madebywild/semantic-layer/database-pool");

export function getPool(): DatabasePool {
  const holder = globalThis as typeof globalThis & { [POOL_KEY]?: DatabasePool };
  holder[POOL_KEY] ??= {
    current: undefined,
    graveyard: [],
    workLock: Promise.resolve(),
    exitHookInstalled: false,
  };
  return holder[POOL_KEY];
}

export function installExitHook(): void {
  const pool = getPool();
  if (pool.exitHookInstalled) return;
  pool.exitHookInstalled = true;
  // Synchronous close in an exit hook is safe (and required — async close resolves before native
  // background threads release their mutexes, which aborts long-running processes on exit). At
  // exit the event loop has drained, so no unit of work can be mid-flight; the lock is moot.
  process.once("exit", () => closePoolNow());
}

/** Immediate, synchronous close of every pooled handle. Only safe when no work is in flight. */
function closePoolNow(): void {
  const pool = getPool();
  const handles = [...(pool.current ? [pool.current.db] : []), ...pool.graveyard];
  pool.current = undefined;
  pool.graveyard = [];
  for (const db of handles) {
    try {
      db.closeSync();
    } catch {
      // Best-effort close at shutdown.
    }
  }
}

/**
 * Closes every pooled database handle after all queued work has finished. Runs automatically at
 * process exit; exported for embedders that need deterministic shutdown (e.g. before deleting a
 * vault directory). It waits on the pool's work lock so it can never close a database out from
 * under an in-flight command. Reopening a just-closed path from the same process is exactly the
 * race the pool exists to avoid, so only call this when the process is done with the database.
 */
export async function closePooledDatabases(): Promise<void> {
  const pool = getPool();
  const run = pool.workLock.then(() => closePoolNow());
  pool.workLock = run.catch(() => undefined);
  return run;
}
