import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  openDatabase,
  withConnection,
  withConnectionForConfig,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
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

  it("releases the database even when the callback throws", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      await expect(
        withConnection(dbPath, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // Proof of release: the file can be opened again directly, no lock or retry needed.
      const db = openDatabase(dbPath);
      db.closeSync();
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
