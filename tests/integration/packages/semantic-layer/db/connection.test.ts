import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  openDatabase,
  withConnection,
  withConnectionForConfig,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import { closePooledDatabases } from "../../../../../packages/semantic-layer/src/db/pool.js";
import { queryRows } from "../../../../../packages/semantic-layer/src/db/cypher.js";
import { createResolvedConfig, createTempDir } from "../../../../helpers.js";

describe("openDatabase", () => {
  it("opens and closes a database file roundtrip", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      const db = openDatabase(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      db.closeSync();
    } finally {
      cleanup();
    }
  });

  it("creates missing parent directories for the database path", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/nested/deep/vault.lbug`;
      const db = openDatabase(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      db.closeSync();
    } finally {
      cleanup();
    }
  });
});

describe("withConnection", () => {
  it("creates the schema and runs the callback", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      const tableCount = await withConnection(dbPath, async (conn) => {
        const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
        return rows.length;
      });
      expect(tableCount).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("drains the WAL at the end of every unit of work", async () => {
    // Regression pin: withConnection must CHECKPOINT before releasing its connection, so the
    // on-disk database is complete for out-of-process readers while the pooled handle stays
    // open, and the exit-time close has no WAL left to hand to a background thread (LadybugDB
    // 0.18.2's close-side checkpointing is asynchronous). Observable as `.wal` being gone.
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      await withConnection(dbPath, async (conn) => {
        await queryRows(conn, 'CREATE (:Note {id: "wal-pin", title: "t"})');
      });
      expect(existsSync(`${dbPath}.wal`)).toBe(false);
      expect(existsSync(`${dbPath}.wal.checkpoint`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("keeps serving new connections after a callback throws", async () => {
    // The pooled database must survive a failing callback: only the per-call Connection is
    // released, and the next withConnection on the same path reuses the pooled handle.
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      await expect(
        withConnection(dbPath, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const tableCount = await withConnection(dbPath, async (conn) => {
        const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
        return rows.length;
      });
      expect(tableCount).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("withConnection — pool concurrency", () => {
  it("serializes concurrent acquires on the same fresh path", async () => {
    // Regression pin: unserialized acquires both opened the same path concurrently, which
    // reproduces LadybugDB 0.18.2's WAL-rename race through a second trigger. The single-flight
    // lock must make overlapping calls share one pooled handle.
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      const [a, b] = await Promise.all([
        withConnection(dbPath, async (conn) => {
          const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
          return rows.length;
        }),
        withConnection(dbPath, async (conn) => {
          const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
          return rows.length;
        }),
      ]);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("survives concurrent acquires on two different paths", async () => {
    const one = createTempDir();
    const two = createTempDir();
    try {
      const [a, b] = await Promise.all([
        withConnection(`${one.dir}/vault.lbug`, async (conn) => {
          const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
          return rows.length;
        }),
        withConnection(`${two.dir}/vault.lbug`, async (conn) => {
          const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
          return rows.length;
        }),
      ]);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(0);
    } finally {
      one.cleanup();
      two.cleanup();
    }
  });
});

describe("closePooledDatabases", () => {
  it("waits for queued work, closes the pooled handle, and is idempotent", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      // Do NOT await the unit of work before closing: closePooledDatabases must queue behind it
      // on the work lock rather than closing the database out from under it.
      const work = withConnection(dbPath, async (conn) => {
        await queryRows(conn, 'CREATE (:Note {id: "pool-close-pin", title: "t"})');
        return "worked";
      });
      await closePooledDatabases();
      await closePooledDatabases();
      await expect(work).resolves.toBe("worked");
      // The WAL was drained by withConnection before the close, so nothing is left behind.
      expect(existsSync(`${dbPath}.wal`)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("withConnection — reentrancy", () => {
  it("throws instead of deadlocking when nested", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      await expect(
        withConnection(dbPath, async () => withConnection(dbPath, async () => "inner")),
      ).rejects.toThrow(/must not be nested/);
    } finally {
      cleanup();
    }
  });
});

describe("withConnectionForConfig", () => {
  it("derives the database path from the config vault directory", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({
        repoRoot: dir,
        vaultDir: `${dir}/vault`,
      });
      const tableCount = await withConnectionForConfig(config, async (conn) => {
        const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
        return rows.length;
      });
      expect(tableCount).toBeGreaterThan(0);
      expect(existsSync(`${dir}/vault/.semantic-layer/vault.lbug`)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
