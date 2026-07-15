import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isManifestCompatible,
  readManifest,
  type SearchIndexManifest,
  writeManifestAtomic,
} from "../../../../../packages/semantic-layer/src/search/manifest.js";
import { createTempDir } from "../../../../helpers.js";

function sampleManifest(overrides?: Partial<SearchIndexManifest>): SearchIndexManifest {
  return {
    schemaVersion: 1,
    vaultDirRelative: "vault",
    lastIndexedSha: "abc123",
    lastIndexedAt: "2026-05-13T00:00:00.000Z",
    embedding: { id: "fastembed:fast-bge-small-en-v1.5", dimensions: 384 },
    chunking: { strategy: "heading", maxChunkChars: 2000 },
    noteCount: 2,
    chunkCount: 5,
    noteContentHashes: { root: "hash-root", demo: "hash-demo" },
    ...overrides,
  };
}

describe("readManifest", () => {
  it("returns undefined when the file doesn't exist", () => {
    const { dir, cleanup } = createTempDir();
    try {
      expect(readManifest(join(dir, "missing.json"))).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns undefined for unparsable JSON", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      writeFileSync(file, "not json{{{");
      expect(readManifest(file)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns undefined for a well-formed JSON value that isn't a manifest", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      writeFileSync(file, JSON.stringify({ hello: "world" }));
      expect(readManifest(file)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns undefined when noteContentHashes has a non-string value", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      const malformed = { ...sampleManifest(), noteContentHashes: { root: 123 } };
      writeFileSync(file, JSON.stringify(malformed));
      expect(readManifest(file)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("round-trips a manifest written by writeManifestAtomic", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      const manifest = sampleManifest();
      writeManifestAtomic(file, manifest);
      expect(readManifest(file)).toEqual(manifest);
    } finally {
      cleanup();
    }
  });
});

describe("writeManifestAtomic", () => {
  it("writes via a tmp file and does not leave the tmp file behind", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      writeManifestAtomic(file, sampleManifest());
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("atomically replaces a previous manifest", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      writeManifestAtomic(file, sampleManifest({ noteCount: 1 }));
      writeManifestAtomic(file, sampleManifest({ noteCount: 9 }));
      expect(readManifest(file)?.noteCount).toBe(9);
    } finally {
      cleanup();
    }
  });

  it("writes readable, formatted JSON", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const file = join(dir, "manifest.json");
      writeManifestAtomic(file, sampleManifest());
      expect(readFileSync(file, "utf8")).toContain("\n  ");
    } finally {
      cleanup();
    }
  });
});

describe("isManifestCompatible", () => {
  const current = {
    vaultDirRelative: "vault",
    embeddingId: "fastembed:fast-bge-small-en-v1.5",
    embeddingDimensions: 384,
    chunking: { strategy: "heading" as const, maxChunkChars: 2000 },
  };

  it("is true when everything matches", () => {
    expect(isManifestCompatible(sampleManifest(), current)).toBe(true);
  });

  it("is false on a schema version mismatch", () => {
    expect(isManifestCompatible(sampleManifest({ schemaVersion: 999 }), current)).toBe(false);
  });

  it("is false when the vault path changed", () => {
    expect(isManifestCompatible(sampleManifest({ vaultDirRelative: "docs" }), current)).toBe(false);
  });

  it("is false when the embedder id changed", () => {
    const manifest = sampleManifest({
      embedding: { id: "gemini:gemini-embedding-001", dimensions: 384 },
    });
    expect(isManifestCompatible(manifest, current)).toBe(false);
  });

  it("is false when embedding dimensions changed", () => {
    const manifest = sampleManifest({
      embedding: { id: current.embeddingId, dimensions: 768 },
    });
    expect(isManifestCompatible(manifest, current)).toBe(false);
  });

  it("is false when chunking strategy changed", () => {
    const manifest = sampleManifest({ chunking: { strategy: "whole-note", maxChunkChars: 2000 } });
    expect(isManifestCompatible(manifest, current)).toBe(false);
  });

  it("is false when maxChunkChars changed", () => {
    const manifest = sampleManifest({ chunking: { strategy: "heading", maxChunkChars: 500 } });
    expect(isManifestCompatible(manifest, current)).toBe(false);
  });
});
