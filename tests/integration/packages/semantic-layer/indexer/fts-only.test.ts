import { describe, expect, it, vi } from "vitest";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import { queryRows } from "../../../../../packages/semantic-layer/src/db/cypher.js";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import {
  createResolvedConfig,
  createTempVault,
  gitCommitAll,
  initGitRepo,
} from "../../../../helpers.js";

function validNote(
  id: string,
  title = id,
  desc = `${title} note.`,
  body = `# ${title}\n\nSome content.`,
): string {
  return `---\nid: ${id}\ntitle: ${title}\ndesc: ${desc}\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

// Simulate the local embedding runtime being unavailable so the indexer falls back to FTS-only.
vi.mock("@huggingface/transformers", () => {
  throw new Error("local embedding runtime unavailable");
});

describe("indexer FTS-only build (embedder unavailable)", () => {
  it("builds an FTS-only index: chunks are stored, no embedding column exists", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md": validNote("alpha", "Alpha", "Alpha note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const result = await buildIndex(config, {}, {});

      expect(result.mode).toBe("full");
      expect(result.ftsOnly).toBe(true);
      expect(result.noteCount).toBe(2);
      expect(result.chunkCount).toBeGreaterThan(0);

      // Without an embedder there is no embedding column at all (it is created per-dimension).
      await withConnectionForConfig(config, async (conn) => {
        const rows = await queryRows(conn, 'CALL table_info("Chunk") RETURN *');
        expect(rows.some((row) => row.name === "embedding")).toBe(false);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("serves fts queries through querySearch but rejects vector and hybrid", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point.", "# Root\n\nfts-only-search-term"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, {});

      // The real query path against a genuinely FTS-only-built database: fts works and
      // actually exercises the FTS index (not a string-contains fallback).
      const ftsResult = await querySearch(config, { query: "fts-only-search-term", mode: "fts" });
      expect(ftsResult.hits.map((hit) => hit.noteId)).toContain("root");

      await expect(querySearch(config, { query: "anything", mode: "vector" })).rejects.toThrow(
        /FTS-only/,
      );
      await expect(querySearch(config, { query: "anything", mode: "hybrid" })).rejects.toThrow(
        /FTS-only/,
      );
    } finally {
      tv.cleanup();
    }
  });

  it("degrades a cold-start vector-mode search to an FTS-only build, then explains itself", async () => {
    // No index at all + local embedder unavailable: querySearch must swallow the embedder load
    // failure, build an FTS-only index, and only then fail the vector query with the
    // actionable FTS-only message (not a native-loader stack trace).
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await expect(querySearch(config, { query: "anything", mode: "hybrid" })).rejects.toThrow(
        /FTS-only/,
      );

      const { existsSync } = await import("node:fs");
      const { dbFileForConfig } = await import(
        "../../../../../packages/semantic-layer/src/db/connection.js"
      );
      expect(existsSync(dbFileForConfig(config))).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("refuses to silently rebuild a vector index as FTS-only", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      // Build WITH an embedder so the index has vectors, then simulate the embedder becoming
      // unavailable: the build must fail loudly instead of destroying the embeddings.
      const { createFakeEmbedder } = await import("../../../../helpers.js");
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      await expect(buildIndex(config, {}, {})).rejects.toThrow(/existing index has embeddings/);
    } finally {
      tv.cleanup();
    }
  });
});
