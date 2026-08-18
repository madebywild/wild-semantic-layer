import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  buildIndex,
  buildIndexWithConnection,
} from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { readIndexMeta } from "../../../../../packages/semantic-layer/src/db/meta.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempVault,
  noteMarkdown,
} from "../../../../helpers.js";

function vault() {
  return createTempVault({
    "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n\nbase text\n" }),
    "vault/alpha.md": noteMarkdown({ id: "alpha", body: "# Alpha\n\nold-token\n" }),
    "vault/root.schema.yml":
      "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
  });
}

describe("incremental SQLite rebuild", () => {
  it("adds, changes, and deletes notes without retaining stale FTS content", async () => {
    const tv = vault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const embedder = createFakeEmbedder();
      await buildIndex(config, { full: true }, { embedder });

      writeFileSync(
        join(tv.vaultDir, "beta.md"),
        noteMarkdown({ id: "beta", body: "# Beta\n\nadded-token\n" }),
      );
      writeFileSync(
        join(tv.vaultDir, "root.schema.yml"),
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha, beta]\n",
      );
      expect(await buildIndex(config, {}, { embedder })).toMatchObject({
        mode: "incremental",
        notesIndexed: 1,
      });
      expect(
        (await querySearch(config, { query: "added-token", mode: "fts" }, { embedder })).hits.map(
          (hit) => hit.noteId,
        ),
      ).toContain("beta");

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMarkdown({ id: "alpha", body: "# Alpha\n\nnew-token\n" }),
      );
      expect(await buildIndex(config, {}, { embedder })).toMatchObject({
        mode: "incremental",
        notesIndexed: 1,
      });
      expect(
        (await querySearch(config, { query: "new-token", mode: "fts" }, { embedder })).hits.map(
          (hit) => hit.noteId,
        ),
      ).toContain("alpha");
      expect(
        (await querySearch(config, { query: "old-token", mode: "fts" }, { embedder })).hits,
      ).toHaveLength(0);

      unlinkSync(join(tv.vaultDir, "beta.md"));
      writeFileSync(
        join(tv.vaultDir, "root.schema.yml"),
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
      );
      expect(await buildIndex(config, {}, { embedder })).toMatchObject({
        mode: "incremental",
        notesRemoved: 1,
      });
      expect(
        (await querySearch(config, { query: "added-token", mode: "fts" }, { embedder })).hits,
      ).toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });

  it("does not mutate an existing index when embedding fails before the transaction", async () => {
    const tv = vault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, { full: true }, { embedder: createFakeEmbedder() });
      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMarkdown({ id: "alpha", body: "# Alpha\n\nwould-be-committed\n" }),
      );
      const failing = {
        id: "failing",
        dimensions: 2,
        embedDocuments: async () => {
          throw new Error("embedding failed");
        },
        embedQuery: async () => [1, 0],
      };
      await expect(buildIndex(config, {}, { embedder: failing })).rejects.toThrow(
        "embedding failed",
      );
      expect(
        (
          await querySearch(
            config,
            { query: "old-token", mode: "fts" },
            { embedder: createFakeEmbedder() },
          )
        ).hits.map((hit) => hit.noteId),
      ).toContain("alpha");
      expect(
        (
          await querySearch(
            config,
            { query: "would-be-committed", mode: "fts" },
            { embedder: createFakeEmbedder() },
          )
        ).hits,
      ).toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });

  it("rolls back the pending index and metadata when FTS integrity validation fails", async () => {
    const tv = vault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const embedder = createFakeEmbedder();
      await withConnectionForConfig(config, async (connection) => {
        await buildIndexWithConnection(connection, config, { full: true }, { embedder });
        const before = readIndexMeta(config, connection);
        if (!before) throw new Error("expected committed SQLite index metadata");
        writeFileSync(
          join(tv.vaultDir, "alpha.md"),
          noteMarkdown({ id: "alpha", body: "# Alpha\n\nnot-committed-token\n" }),
        );
        const sabotaged = new Proxy(connection, {
          get(target, property, receiver) {
            if (property === "prepare") {
              return (sql: string) => {
                if (sql.includes("integrity-check"))
                  throw new Error("forced FTS integrity failure");
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

        await expect(buildIndexWithConnection(sabotaged, config, {}, { embedder })).rejects.toThrow(
          "forced FTS integrity failure",
        );
        expect(
          connection.prepare("SELECT search_text FROM chunks WHERE note_id = ?").all("alpha"),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ search_text: expect.stringContaining("old-token") }),
          ]),
        );
        expect(readIndexMeta(config, connection)?.noteContentHashes).toEqual(
          before.noteContentHashes,
        );
      });
    } finally {
      tv.cleanup();
    }
  });
});
