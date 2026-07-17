import { existsSync } from "node:fs";
import { Connection } from "../../../../../packages/semantic-layer/node_modules/@ladybugdb/core";
import { describe, expect, it } from "vitest";
import {
  closeConnection,
  closeDatabase,
  openDatabase,
  withConnection,
  withConnectionForConfig,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import { createResolvedConfig, createTempDir } from "../../../../helpers.js";

describe("openDatabase / closeDatabase", () => {
  it("opens and closes a database file roundtrip", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      const db = openDatabase(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      closeDatabase(db);
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
      closeDatabase(db);
    } finally {
      cleanup();
    }
  });
});

describe("closeConnection", () => {
  it("closes an open connection", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const db = openDatabase(`${dir}/vault.lbug`);
      const conn = new Connection(db);
      await conn.init();
      closeConnection(conn);
      closeDatabase(db);
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
        const result = await conn.query("CALL SHOW_TABLES() RETURN *");
        const rows = await result.getAll();
        return rows.length;
      });
      expect(tableCount).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("closes the connection and database even when the callback throws", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const dbPath = `${dir}/vault.lbug`;
      await expect(
        withConnection(dbPath, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
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
        const result = await conn.query("CALL SHOW_TABLES() RETURN *");
        const rows = await result.getAll();
        return rows.length;
      });
      expect(tableCount).toBeGreaterThan(0);
      expect(existsSync(`${dir}/vault/.semantic-layer/vault.lbug`)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
