import { describe, expect, it } from "vitest";
import {
  dbFileForConfig,
  openDatabase,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  buildStalenessReasons,
  configStalenessReasons,
  embedderMeta,
  embeddingStalenessReason,
  type IndexMeta,
  isIndexStale,
  readBooleanMetadata,
  readIndexMeta,
  writeBooleanMetadata,
  writeIndexMeta,
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
    wikilinks: { aliasOrder: "dendron" },
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
      expect(readIndexMeta(config)).toMatchObject({ noteContentHashes: { root: "hash" } });
    } finally {
      cleanup();
    }
  });

  it("detects schema, chunking, and wikilink config drift", () => {
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
    expect(
      configStalenessReasons(config, {
        ...current,
        wikilinks: { aliasOrder: "obsidian" },
      }),
    ).toContain("wikilink alias-order config changed since the index was built");
    expect(embedderMeta()).toEqual({ kind: "fts-only" });
  });

  it("treats absent, uninitialized, malformed, and invalid metadata as unavailable", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
      expect(readIndexMeta(config)).toBeUndefined();

      const db = openDatabase(dbFileForConfig(config));
      expect(readIndexMeta(config, db)).toBeUndefined();
      expect(readBooleanMetadata(db, "missing")).toBeUndefined();
      createSchema(db);
      db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("index_meta", "{");
      expect(readIndexMeta(config, db)).toBeUndefined();
      db.prepare("UPDATE metadata SET value = ? WHERE key = ?").run(
        JSON.stringify({ schemaVersion: "wrong" }),
        "index_meta",
      );
      expect(readIndexMeta(config, db)).toBeUndefined();
      writeBooleanMetadata(db, "migration_done", true);
      expect(readBooleanMetadata(db, "migration_done")).toBe(true);
      writeBooleanMetadata(db, "migration_done", false);
      expect(readBooleanMetadata(db, "migration_done")).toBe(false);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("reports vault and embedder drift with actionable reasons", () => {
    const config = createResolvedConfig();
    const indexed = {
      ...meta(config),
      embedding: { kind: "embedder" as const, id: "fake:old", dimensions: 2 },
    };
    expect(configStalenessReasons(config, { ...indexed, vaultDir: "/another-vault" })).toContain(
      "index was built for a different vault directory",
    );
    expect(embeddingStalenessReason(indexed, undefined)).toContain("no embedder is available");
    expect(embeddingStalenessReason(indexed, { id: "fake:new", dimensions: 3 })).toContain(
      'built with embedder "fake:old"',
    );
    expect(
      embeddingStalenessReason(
        { ...indexed, embedding: { kind: "fts-only" } },
        {
          id: "fake:new",
          dimensions: 3,
        },
      ),
    ).toContain("built without embeddings");
    expect(
      embeddingStalenessReason({ ...indexed, embedding: { kind: "fts-only" } }, undefined),
    ).toBeUndefined();
    expect(
      buildStalenessReasons(config, indexed, {
        id: "fake:old",
        dimensions: 2,
        embedDocuments: async () => [],
        embedQuery: async () => [],
      }),
    ).toEqual([]);
    expect(isIndexStale(config, { ...indexed, schemaVersion: 0 })).toBe(true);
    expect(
      embedderMeta({
        id: "fake:new",
        dimensions: 3,
        embedDocuments: async () => [],
        embedQuery: async () => [],
      }),
    ).toEqual({ kind: "embedder", id: "fake:new", dimensions: 3 });
  });
});
