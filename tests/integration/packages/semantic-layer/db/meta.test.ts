import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  embedderMeta,
  indexMetaPath,
  isIndexStale,
  readIndexMeta,
  writeIndexMeta,
  type IndexMeta,
} from "../../../../../packages/semantic-layer/src/db/meta.js";
import { SCHEMA_VERSION } from "../../../../../packages/semantic-layer/src/db/schema.js";
import type { Embedder } from "../../../../../packages/semantic-layer/src/search/embedder.js";
import { createResolvedConfig, createTempDir } from "../../../../helpers.js";

function fakeEmbedder(id: string, dimensions: number): Embedder {
  return {
    id,
    dimensions,
    embedDocuments: (texts) => Promise.resolve(texts.map(() => new Array(dimensions).fill(0))),
    embedQuery: () => Promise.resolve(new Array(dimensions).fill(0)),
  };
}

function sampleMeta(overrides?: Partial<IndexMeta>): IndexMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    vaultDir: "/tmp/test-repo/vault",
    lastIndexedSha: "abc123",
    lastIndexedAt: new Date().toISOString(),
    embedding: { kind: "embedder", id: "fastembed:fast-bge-small-en-v1.5", dimensions: 384 },
    chunking: { strategy: "heading", maxChunkChars: 2000 },
    noteContentHashes: {},
    ...overrides,
  };
}

describe("indexMetaPath", () => {
  it("lives inside the vault directory under .semantic-layer", () => {
    const config = createResolvedConfig({ vaultDir: "/tmp/test-repo/vault" });
    expect(indexMetaPath(config)).toBe("/tmp/test-repo/vault/.semantic-layer/vault.lbug.meta.json");
  });
});

describe("readIndexMeta / writeIndexMeta", () => {
  it("round-trips a meta object through the filesystem atomically", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({
        repoRoot: dir,
        vaultDir: `${dir}/vault`,
      });
      const meta = sampleMeta({ vaultDir: config.vaultDir });
      writeIndexMeta(config, meta);
      const read = readIndexMeta(config);
      expect(read).toEqual(meta);
    } finally {
      cleanup();
    }
  });

  it("returns undefined when the meta file is missing", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({
        repoRoot: dir,
        vaultDir: `${dir}/vault`,
      });
      expect(readIndexMeta(config)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns undefined when the meta file contains invalid JSON", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({
        repoRoot: dir,
        vaultDir: `${dir}/vault`,
      });
      mkdirSync(`${dir}/vault/.semantic-layer`, { recursive: true });
      writeFileSync(indexMetaPath(config), "not json");
      expect(readIndexMeta(config)).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("isIndexStale (the build-time rebuild decision)", () => {
  it("is stale when the schema version mismatches", () => {
    const config = createResolvedConfig();
    const meta = sampleMeta({ schemaVersion: 999 });
    expect(isIndexStale(config, meta)).toBe(true);
  });

  it("is stale when the vault directory changes", () => {
    const config = createResolvedConfig({ vaultDir: "/new/vault" });
    const meta = sampleMeta({ vaultDir: "/old/vault" });
    expect(isIndexStale(config, meta)).toBe(true);
  });

  it("is stale when chunking strategy changes", () => {
    const config = createResolvedConfig({
      search: {
        ...createResolvedConfig().search,
        chunking: { strategy: "whole-note", maxChunkChars: 2000 },
      },
    });
    expect(isIndexStale(config, sampleMeta())).toBe(true);
  });

  it("is stale when maxChunkChars changes", () => {
    const config = createResolvedConfig({
      search: {
        ...createResolvedConfig().search,
        chunking: { strategy: "heading", maxChunkChars: 1000 },
      },
    });
    expect(isIndexStale(config, sampleMeta())).toBe(true);
  });

  it("is stale when the embedder id mismatches", () => {
    const config = createResolvedConfig();
    const embedder = fakeEmbedder("gemini:gemini-embedding-001", 3072);
    expect(isIndexStale(config, sampleMeta(), embedder)).toBe(true);
  });

  it("is stale when the embedder dimensions mismatch", () => {
    const config = createResolvedConfig();
    const embedder = fakeEmbedder("fastembed:fast-bge-small-en-v1.5", 768);
    expect(isIndexStale(config, sampleMeta(), embedder)).toBe(true);
  });

  it("is stale when an embedder is available but the index was built FTS-only", () => {
    const config = createResolvedConfig();
    const meta = sampleMeta({ embedding: { kind: "fts-only" } });
    const embedder = fakeEmbedder("fastembed:fast-bge-small-en-v1.5", 384);
    expect(isIndexStale(config, meta, embedder)).toBe(true);
  });

  it("is stale when no embedder is available but the index has embeddings", () => {
    const config = createResolvedConfig();
    expect(isIndexStale(config, sampleMeta())).toBe(true);
  });

  it("is fresh when an FTS-only index meets a missing embedder", () => {
    const config = createResolvedConfig();
    const meta = sampleMeta({ embedding: { kind: "fts-only" } });
    expect(isIndexStale(config, meta)).toBe(false);
  });

  it("is fresh when everything matches, even without a stored SHA", () => {
    // Git state is not part of the rebuild decision: content hashes reconcile the vault.
    const config = createResolvedConfig();
    const meta = sampleMeta({
      vaultDir: config.vaultDir,
      lastIndexedSha: undefined,
      embedding: { kind: "fts-only" },
    });
    expect(isIndexStale(config, meta)).toBe(false);
  });
});

describe("embedderMeta", () => {
  it("returns the fts-only marker when no embedder is given", () => {
    expect(embedderMeta()).toEqual({ kind: "fts-only" });
  });

  it("returns kind, id and dimensions for an embedder", () => {
    const embedder = fakeEmbedder("fastembed:fast-bge-small-en-v1.5", 384);
    expect(embedderMeta(embedder)).toEqual({
      kind: "embedder",
      id: embedder.id,
      dimensions: embedder.dimensions,
    });
  });
});
