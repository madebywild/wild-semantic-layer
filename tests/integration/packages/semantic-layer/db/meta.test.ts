import { describe, expect, it } from "vitest";
import {
  dbFileForConfig,
  openDatabase,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  configStalenessReasons,
  embedderMeta,
  readIndexMeta,
  writeIndexMeta,
  type IndexMeta,
} from "../../../../../packages/semantic-layer/src/db/meta.js";
import {
  createSchema,
  SCHEMA_VERSION,
} from "../../../../../packages/semantic-layer/src/db/schema.js";
import { createResolvedConfig, createTempDir } from "../../../../helpers.js";

function meta(config: ReturnType<typeof createResolvedConfig>): IndexMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    vaultDir: config.vaultDir,
    lastIndexedAt: new Date().toISOString(),
    embedding: { kind: "fts-only" },
    chunking: { strategy: "heading", maxChunkChars: 2000 },
    noteContentHashes: { root: "hash" },
  };
}

describe("SQLite index metadata", () => {
  it("stores metadata inside vault.sqlite with no sidecar", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
      const db = openDatabase(dbFileForConfig(config));
      createSchema(db);
      writeIndexMeta(meta(config), db);
      expect(readIndexMeta(config, db)).toMatchObject({ noteContentHashes: { root: "hash" } });
      db.close();
    } finally {
      cleanup();
    }
  });

  it("detects schema and chunking config drift", () => {
    const config = createResolvedConfig();
    const current = { ...meta(config), vaultDir: config.vaultDir };
    expect(configStalenessReasons(config, { ...current, schemaVersion: 0 }).join("\n")).toMatch(
      /schema version/,
    );
    expect(
      configStalenessReasons(config, {
        ...current,
        chunking: { strategy: "whole-note", maxChunkChars: 100 },
      }),
    ).toContain("chunking config changed since the index was built");
    expect(embedderMeta()).toEqual({ kind: "fts-only" });
  });
});
