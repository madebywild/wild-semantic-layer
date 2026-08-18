import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dbFileForConfig,
  withConnectionForConfig,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import { buildIndex, hashNote } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { readIndexMeta } from "../../../../../packages/semantic-layer/src/db/meta.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempVault,
  noteMarkdown,
} from "../../../../helpers.js";

describe("SQLite indexer", () => {
  it("builds the complete derived state into vault.sqlite", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n\nunique indexed phrase\n" }),
    });
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const result = await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      expect(result).toMatchObject({
        mode: "full",
        noteCount: 1,
        indexPath: dbFileForConfig(config),
      });
      expect(existsSync(result.indexPath)).toBe(true);
      await withConnectionForConfig(config, (db) => {
        expect(readIndexMeta(config, db)?.noteContentHashes).toHaveProperty("root");
        expect(db.prepare("SELECT count(*) AS count FROM chunks").get()).toMatchObject({
          count: result.chunkCount,
        });
      });
      expect(
        (
          await querySearch(
            config,
            { query: "unique", mode: "fts" },
            { embedder: createFakeEmbedder() },
          )
        ).hits,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: "root" })]));
    } finally {
      tv.cleanup();
    }
  });

  it("hashes a note deterministically and includes frontmatter", () => {
    const note = {
      id: "root",
      file: "root.md",
      fm: {
        id: "root",
        title: "Root",
        desc: "Root",
        status: "active" as const,
        owner: "o",
        last_verified: "2026-08-18",
        ttl_days: 1,
      },
      body: "content",
      headings: new Set<string>(),
      headingSpans: [],
    };
    expect(hashNote(note)).toBe(hashNote(note));
    expect(hashNote({ ...note, body: "changed" })).not.toBe(hashNote(note));
  });

  it("skips wikilink-shaped prose when the target note does not exist", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({
        id: "root",
        body: "# Root\n\nExternal notation [[not-a-vault-note]] must not create a dangling edge.\n",
      }),
    });
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      await withConnectionForConfig(config, (db) => {
        expect(db.prepare("SELECT count(*) AS count FROM links").get()).toMatchObject({ count: 0 });
      });
    } finally {
      tv.cleanup();
    }
  });
});
