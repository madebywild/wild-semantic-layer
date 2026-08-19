import type { DatabaseSync } from "node:sqlite";

export type PooledDatabase = { path: string; db: DatabaseSync };

type DatabasePool = {
  current: PooledDatabase | undefined;
  workLock: Promise<unknown>;
  exitHookInstalled: boolean;
};

const POOL_KEY = Symbol.for("@madebywild/semantic-layer/sqlite-pool");

export function getPool(): DatabasePool {
  const holder = globalThis as typeof globalThis & { [POOL_KEY]?: DatabasePool };
  holder[POOL_KEY] ??= {
    current: undefined,
    workLock: Promise.resolve(),
    exitHookInstalled: false,
  };
  return holder[POOL_KEY];
}

export function installExitHook(): void {
  const pool = getPool();
  if (pool.exitHookInstalled) return;
  pool.exitHookInstalled = true;
  process.once("exit", closePoolNow);
}

function closePoolNow(): void {
  const pool = getPool();
  const current = pool.current;
  pool.current = undefined;
  if (current) {
    try {
      current.db.close();
    } catch {
      // Best effort at process shutdown.
    }
  }
}
