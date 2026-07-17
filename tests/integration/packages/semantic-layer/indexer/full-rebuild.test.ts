import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  createFakeEmbedder,
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

describe("indexer full rebuild", () => {
  it("builds an index with correct note and chunk counts", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md": validNote("alpha", "Alpha", "Alpha note."),
      "vault/beta.md": validNote("beta", "Beta", "Beta note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha, beta]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const result = await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      expect(result.mode).toBe("full");
      expect(result.noteCount).toBe(3);
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(result.ftsOnly).toBe(false);

      await withConnectionForConfig(config, async (conn) => {
        const noteResult = await conn.query("MATCH (n:Note) RETURN count(n) AS cnt");
        expect(Number((await noteResult.getAll())[0]?.cnt)).toBe(3);

        const chunkResult = await conn.query("MATCH (c:Chunk) RETURN count(c) AS cnt");
        expect(Number((await chunkResult.getAll())[0]?.cnt)).toBe(result.chunkCount);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("indexes chunks for FTS search, including tokens adjacent to newlines", async () => {
    // LadybugDB 0.18.2's FTS tokenizer does not treat newlines as separators: tokens touching a
    // line break fuse into unsearchable compounds (verified: "beta\ngamma" indexes as one token).
    // Chunk text is full of newlines (title/desc prefix, breadcrumb), so the indexer stores a
    // newline-normalized `searchText` copy for FTS while `text` stays pristine. Without that
    // normalization, "Zebra" (title, fused with the breadcrumb newline) and "Entry" would both
    // return zero hits — this pins the workaround.
    const tv = createTempVault({
      "vault/root.md": validNote(
        "root",
        "Zebra",
        "Entry point.",
        "# Zebra\n\nunique-search-term-12345",
      ),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      await withConnectionForConfig(config, async (conn) => {
        for (const term of ["Zebra", "Entry", "unique-search-term-12345"]) {
          const stmt = await conn.prepare(
            `CALL QUERY_FTS_INDEX("Chunk", "searchText", $term)
             YIELD node AS chunk, score
             RETURN chunk.noteId AS noteId`,
          );
          const result = await conn.execute(stmt, { term });
          const single = Array.isArray(result) ? result[0] : result;
          const rows = await single.getAll();
          expect(
            rows.map((row: Record<string, unknown>) => row.noteId),
            `FTS hit for "${term}"`,
          ).toContain("root");
        }

        // The display copy must remain pristine (newlines intact, no normalization artifacts).
        const textRows = await conn.query('MATCH (c:Chunk {id: "root"}) RETURN c.text AS text');
        const firstText = String((await textRows.getAll())[0]?.text ?? "");
        expect(firstText).toContain("\n");
        expect(firstText).not.toContain("zzsl");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("indexes hierarchy edges from dot-delimited note ids", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.alpha.md": validNote("root.alpha", "Alpha", "Alpha note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [root.alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      await withConnectionForConfig(config, async (conn) => {
        const result = await conn.query(
          'MATCH (root:Note {id: "root"})-[:HAS_CHILD]->(alpha:Note {id: "root.alpha"}) RETURN alpha.id AS id',
        );
        expect((await result.getAll())[0]?.id).toBe("root.alpha");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("indexes wikilink edges", async () => {
    const tv = createTempVault({
      "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n# Root\n\nSee [[alpha]] and [[alpha#section]].\n`,
      "vault/alpha.md": validNote("alpha", "Alpha", "Alpha note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      await withConnectionForConfig(config, async (conn) => {
        const result = await conn.query(
          'MATCH (root:Note {id: "root"})-[:LINKS_TO]->(alpha:Note {id: "alpha"}) RETURN count(*) AS cnt',
        );
        expect(Number((await result.getAll())[0]?.cnt)).toBe(2);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("indexes resolved code-ref edges", async () => {
    const tv = createTempVault({
      "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\ncode_refs:\n  - file: src/service.ts\n    symbol: issueToken\n---\n\nRoot.`,
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      "src/service.ts": "export function issueToken() { return 'token'; }\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      await withConnectionForConfig(config, async (conn) => {
        const result = await conn.query(
          'MATCH (n:Note {id: "root"})-[:DECLARES_CODE_REF]->(s:CodeSymbol {symbol: "issueToken"}) RETURN s.file AS file',
        );
        expect((await result.getAll())[0]?.file).toBe("src/service.ts");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("writes embeddings on chunks", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await buildIndex(config, {}, { embedder: createFakeEmbedder(8) });

      await withConnectionForConfig(config, async (conn) => {
        const result = await conn.query(
          "MATCH (c:Chunk) WHERE c.embedding IS NOT NULL RETURN count(c) AS cnt",
        );
        expect(Number((await result.getAll())[0]?.cnt)).toBeGreaterThan(0);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("writes the meta sidecar", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const result = await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      const meta = JSON.parse(readFileSync(result.metaFile, "utf8"));
      expect(meta.schemaVersion).toBeDefined();
      expect(meta.embedding.id).toContain("fake");
      expect(meta.noteContentHashes).toHaveProperty("root");
    } finally {
      tv.cleanup();
    }
  });

  it("recovers from a database left behind by an older schema version", async () => {
    // Simulate a pre-searchText database: Chunk without the searchText column and an FTS index
    // named "text" (the old column name). The rebuild must drop those differently-named indexes
    // and tables instead of dying on the upgrade path.
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point.", "# Root\n\nlegacy upgrade test"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      const { dbFileForConfig, openDatabase } = await import(
        "../../../../../packages/semantic-layer/src/db/connection.js"
      );
      // Write the legacy-shape fixture to a scratch path and copy it into place after close:
      // reopening the same database file twice in one process trips LadybugDB 0.18.2's WAL
      // checkpoint race (see connection.ts), while the target path was never opened here.
      const { Connection } = await import(
        "../../../../../packages/semantic-layer/node_modules/@ladybugdb/core"
      );
      const scratch = `${tv.dir}/fixture.lbug`;
      const db = openDatabase(scratch);
      const conn = new Connection(db);
      await conn.init();
      await conn.query("INSTALL FTS");
      await conn.query("LOAD EXTENSION FTS");
      await conn.query(
        "CREATE NODE TABLE Chunk(id STRING PRIMARY KEY, noteId STRING, text STRING)",
      );
      await conn.query('CALL CREATE_FTS_INDEX("Chunk", "text", ["text"])');
      await conn.query("CREATE (c:Chunk {id: 'old', noteId: 'root', text: 'stale content'})");
      conn.closeSync();
      db.closeSync();

      const { copyFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const dbPath = dbFileForConfig(config);
      mkdirSync(dirname(dbPath), { recursive: true });
      copyFileSync(scratch, dbPath);

      const result = await buildIndex(config, {}, { embedder: createFakeEmbedder() });
      expect(result.mode).toBe("full");
      expect(result.noteCount).toBe(1);

      await withConnectionForConfig(config, async (conn2) => {
        const stmt = await conn2.prepare(
          `CALL QUERY_FTS_INDEX("Chunk", "searchText", $term)
           YIELD node AS chunk, score
           RETURN chunk.noteId AS noteId`,
        );
        const queryResult = await conn2.execute(stmt, { term: "upgrade" });
        const single = Array.isArray(queryResult) ? queryResult[0] : queryResult;
        const rows = await single.getAll();
        expect(rows.map((row: Record<string, unknown>) => row.noteId)).toContain("root");
      });
    } finally {
      tv.cleanup();
    }
  });
});
