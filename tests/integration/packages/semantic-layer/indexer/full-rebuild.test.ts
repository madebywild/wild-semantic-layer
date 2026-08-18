import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dbFileForConfig,
  discardPooledDatabase,
} from "../../../../../packages/semantic-layer/src/db/connection.js";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempVault,
  noteMarkdown,
} from "../../../../helpers.js";

describe("full SQLite rebuild and migration", () => {
  it("detects config drift and rebuilds the same SQLite index", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n\nconfig drift token\n" }),
    });
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      const drifted = {
        ...config,
        search: {
          ...config.search,
          chunking: { strategy: "whole-note" as const, maxChunkChars: 100 },
        },
      };
      expect(await buildIndex(drifted, {}, { embedder: createFakeEmbedder() })).toMatchObject({
        mode: "full",
      });
      expect(
        (
          await querySearch(
            drifted,
            { query: "drift", mode: "fts" },
            { embedder: createFakeEmbedder() },
          )
        ).hits,
      ).not.toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });

  it("preserves legacy LadybugDB artifacts and emits the one-time migration notice", async () => {
    const tv = createTempVault({ "vault/root.md": noteMarkdown({ id: "root" }) });
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const legacy = join(tv.vaultDir, ".semantic-layer", "vault.lbug");
      mkdirSync(join(tv.vaultDir, ".semantic-layer"), { recursive: true });
      writeFileSync(legacy, "legacy derived artifact");
      const first = await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      expect(first.legacyMigrationNotice).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      expect(await buildIndex(config, {}, { embedder: createFakeEmbedder() })).toMatchObject({
        legacyMigrationNotice: false,
      });
    } finally {
      tv.cleanup();
    }
  });

  it("quarantines a physically corrupt derived database and rebuilds it", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n\nrecover token\n" }),
    });
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      const indexPath = dbFileForConfig(config);
      discardPooledDatabase(indexPath);
      writeFileSync(indexPath, "not sqlite");
      const result = await buildIndex(config, {}, { embedder: createFakeEmbedder() });
      expect(result.mode).toBe("full");
      expect(readdirSync(join(tv.vaultDir, ".semantic-layer"))).toContainEqual(
        expect.stringMatching(/vault\.sqlite\.corrupt-/),
      );
      expect(
        (
          await querySearch(
            config,
            { query: "recover", mode: "fts" },
            { embedder: createFakeEmbedder() },
          )
        ).hits.map((hit) => hit.noteId),
      ).toContain("root");
    } finally {
      tv.cleanup();
    }
  });
});
