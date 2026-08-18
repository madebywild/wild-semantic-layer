import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dbFileForConfig,
  isCorruptionError,
  openDatabase,
  quarantineDatabaseArtifacts,
  withConnection,
  withConnectionForConfig,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import { createResolvedConfig, createTempDir } from "../../../../helpers.js";

describe("SQLite connection", () => {
  it("creates the configured single-file SQLite index with WAL and FTS5", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
      const dbPath = dbFileForConfig(config);
      await withConnectionForConfig(config, (db) => {
        expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
        db.exec("CREATE VIRTUAL TABLE temp.connection_fts USING fts5(content)");
        db.exec("DROP TABLE temp.connection_fts");
      });
      expect(dbPath).toBe(`${dir}/vault/.semantic-layer/vault.sqlite`);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("serializes work and rejects nested use instead of deadlocking", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const path = `${dir}/vault.sqlite`;
      const values = await Promise.all([
        withConnection(path, (db) => {
          db.exec("CREATE TABLE IF NOT EXISTS values_table (value INTEGER)");
          db.prepare("INSERT INTO values_table VALUES (?)").run(1);
          return 1;
        }),
        withConnection(path, (db) => {
          db.prepare("INSERT INTO values_table VALUES (?)").run(2);
          return 2;
        }),
      ]);
      expect(values).toEqual([1, 2]);
      await expect(withConnection(path, () => withConnection(path, () => 3))).rejects.toThrow(
        /must not be nested/,
      );
    } finally {
      cleanup();
    }
  });

  it("quarantines only SQLite corruption artifacts", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.sqlite`;
      const db = openDatabase(dbPath);
      db.close();
      const moved = quarantineDatabaseArtifacts(dbPath);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatch(/vault\.sqlite\.corrupt-/);
      expect(existsSync(dbPath)).toBe(false);
      expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
      expect(isCorruptionError(new Error("permission denied"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
