import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import { buildIndexWithConnection } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempVault,
  gitCommitAll,
  initGitRepo,
} from "../../../../helpers.js";

type IndexMetaFile = {
  lastIndexedSha?: string;
  noteContentHashes: Record<string, string>;
};

function readMeta(metaFile: string): IndexMetaFile {
  return JSON.parse(readFileSync(metaFile, "utf8")) as IndexMetaFile;
}

function validNote(
  id: string,
  title = id,
  desc = `${title} note.`,
  body = `# ${title}\n\nSome content.`,
): string {
  return `---\nid: ${id}\ntitle: ${title}\ndesc: ${desc}\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

describe("indexer incremental rebuild", () => {
  // LadybugDB 0.18.2's native close is not fully synchronous; repeatedly opening and closing the
  // same database in one test races on WAL checkpointing. These tests reuse a single connection
  // across the initial full build and the follow-up incremental build.
  it("reindexes only the changed note", async () => {
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
      await withConnectionForConfig(config, async (conn) => {
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(first.mode).toBe("full");
        const firstMeta = readMeta(first.metaFile);

        const fs = await import("node:fs");
        fs.writeFileSync(
          `${tv.vaultDir}/alpha.md`,
          validNote("alpha", "Alpha", "Alpha note updated.", "# Alpha\n\nUpdated content."),
        );
        gitCommitAll(tv.dir, "update alpha");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(1);
        expect(result.notesRemoved).toBe(0);
        expect(result.noteCount).toBe(3);

        const meta = readMeta(result.metaFile);
        expect(meta.noteContentHashes.alpha).not.toBe(firstMeta.noteContentHashes.alpha);
        expect(meta.noteContentHashes.root).toBe(firstMeta.noteContentHashes.root);
        expect(meta.noteContentHashes.beta).toBe(firstMeta.noteContentHashes.beta);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("removes a deleted note from the index", async () => {
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
      await withConnectionForConfig(config, async (conn) => {
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(first.noteCount).toBe(2);

        const fs = await import("node:fs");
        fs.unlinkSync(`${tv.vaultDir}/alpha.md`);
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
        );
        gitCommitAll(tv.dir, "delete alpha");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesRemoved).toBe(1);
        expect(result.noteCount).toBe(1);

        const meta = readMeta(result.metaFile);
        expect(meta.noteContentHashes).not.toHaveProperty("alpha");
        expect(meta.noteContentHashes).toHaveProperty("root");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("adds a newly created note", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(first.noteCount).toBe(1);

        const fs = await import("node:fs");
        fs.writeFileSync(`${tv.vaultDir}/alpha.md`, validNote("alpha", "Alpha", "Alpha note."));
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
        );
        gitCommitAll(tv.dir, "add alpha");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(1);
        expect(result.noteCount).toBe(2);

        const meta = readMeta(result.metaFile);
        expect(meta.noteContentHashes).toHaveProperty("alpha");
        expect(meta.noteContentHashes).toHaveProperty("root");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("handles a renamed note as delete plus add", async () => {
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
      await withConnectionForConfig(config, async (conn) => {
        await buildIndexWithConnection(conn, config, {}, { embedder: createFakeEmbedder() });

        const fs = await import("node:fs");

        // Commit the delete first so git cannot detect a rename.
        fs.unlinkSync(`${tv.vaultDir}/alpha.md`);
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
        );
        gitCommitAll(tv.dir, "delete alpha");

        // Then commit the add as a separate change.
        fs.writeFileSync(`${tv.vaultDir}/beta.md`, validNote("beta", "Beta", "Beta note."));
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [beta]\n",
        );
        gitCommitAll(tv.dir, "add beta");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(1);
        expect(result.notesRemoved).toBe(1);
        expect(result.noteCount).toBe(2);

        const meta = readMeta(result.metaFile);
        expect(meta.noteContentHashes).toHaveProperty("beta");
        expect(meta.noteContentHashes).not.toHaveProperty("alpha");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("restores inbound wikilinks when a target note is re-created during incremental rebuild", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md": validNote(
        "alpha",
        "Alpha",
        "Alpha note.",
        "# Alpha\n\nSee [[root]] for context.\n",
      ),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        await buildIndexWithConnection(conn, config, {}, { embedder: createFakeEmbedder() });

        const fs = await import("node:fs");
        fs.writeFileSync(
          `${tv.vaultDir}/root.md`,
          validNote("root", "Root", "Entry point updated."),
        );
        gitCommitAll(tv.dir, "update root");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(1);

        const inbound = await conn.query(
          'MATCH (source:Note {id: "alpha"})-[:LINKS_TO]->(target:Note {id: "root"}) RETURN source.id AS id',
        );
        expect((await inbound.getAll()).map((row: Record<string, unknown>) => row.id)).toEqual([
          "alpha",
        ]);

        const outbound = await conn.query(
          'MATCH (source:Note {id: "alpha"})-[:LINKS_TO]->() RETURN count(source) AS cnt',
        );
        expect(Number((await outbound.getAll())[0]?.cnt)).toBe(1);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("does nothing when no notes changed", async () => {
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
      await withConnectionForConfig(config, async (conn) => {
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );

        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(0);
        expect(result.notesRemoved).toBe(0);
        expect(result.noteCount).toBe(2);
        expect(readMeta(result.metaFile).noteContentHashes).toEqual(
          readMeta(first.metaFile).noteContentHashes,
        );
      });
    } finally {
      tv.cleanup();
    }
  });

  it("removes a note that git never tracked when it disappears from the vault", async () => {
    // Deletion detection must reconcile the stored content hashes against the live vault, not
    // trust git: a note indexed while untracked and then deleted (never committed) leaves no
    // trace in any git diff, but must still leave the index.
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        const fs = await import("node:fs");
        fs.writeFileSync(`${tv.vaultDir}/ghost.md`, validNote("ghost", "Ghost", "Ghost note."));
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(first.noteCount).toBe(2);

        fs.unlinkSync(`${tv.vaultDir}/ghost.md`);
        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );

        expect(result.mode).toBe("incremental");
        expect(result.notesRemoved).toBe(1);
        expect(result.noteCount).toBe(1);
        expect(readMeta(result.metaFile).noteContentHashes).not.toHaveProperty("ghost");

        const noteRows = await conn.query('MATCH (n:Note {id: "ghost"}) RETURN count(n) AS cnt');
        expect(Number((await noteRows.getAll())[0]?.cnt)).toBe(0);
        const chunkRows = await conn.query(
          'MATCH (c:Chunk {noteId: "ghost"}) RETURN count(c) AS cnt',
        );
        expect(Number((await chunkRows.getAll())[0]?.cnt)).toBe(0);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("keeps edges between two notes that both changed exactly once", async () => {
    // Both endpoints are deleted and re-inserted in the same run; the shared edge must come back
    // exactly once (not zero times because both MATCHes failed, not twice because both inserts
    // re-created it).
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point.", "# Root\n\nSee [[root.alpha]].\n"),
      "vault/root.alpha.md": validNote(
        "root.alpha",
        "Alpha",
        "Alpha note.",
        "# Alpha\n\nBack to [[root]].\n",
      ),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [root.alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        await buildIndexWithConnection(conn, config, {}, { embedder: createFakeEmbedder() });

        const fs = await import("node:fs");
        fs.writeFileSync(
          `${tv.vaultDir}/root.md`,
          validNote("root", "Root", "Entry updated.", "# Root\n\nSee [[root.alpha]] now.\n"),
        );
        fs.writeFileSync(
          `${tv.vaultDir}/root.alpha.md`,
          validNote("root.alpha", "Alpha", "Alpha updated.", "# Alpha\n\nBack to [[root]] now.\n"),
        );
        gitCommitAll(tv.dir, "change both");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(2);

        const linkRows = await conn.query("MATCH ()-[r:LINKS_TO]->() RETURN count(r) AS cnt");
        expect(Number((await linkRows.getAll())[0]?.cnt)).toBe(2);
        const childRows = await conn.query(
          'MATCH (:Note {id: "root"})-[r:HAS_CHILD]->(:Note {id: "root.alpha"}) RETURN count(r) AS cnt',
        );
        expect(Number((await childRows.getAll())[0]?.cnt)).toBe(1);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("rebuilds incrementally in a vault that is not a git repo at all", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md": validNote("alpha", "Alpha", "Alpha note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    });
    // No initGitRepo: change detection must work from content hashes alone.

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        const first = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(first.mode).toBe("full");

        const fs = await import("node:fs");
        fs.writeFileSync(
          `${tv.vaultDir}/alpha.md`,
          validNote("alpha", "Alpha", "Alpha updated.", "# Alpha\n\nUpdated content."),
        );

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");
        expect(result.notesIndexed).toBe(1);
        expect(result.noteCount).toBe(2);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("keeps Schema node title and namespace correct after incremental builds", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md": validNote("alpha", "Alpha", "Alpha note."),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    title: Root Schema\n    parent: root\n    children: [alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        await buildIndexWithConnection(conn, config, {}, { embedder: createFakeEmbedder() });

        // Touch a note to force an incremental run; the schema file only gains `namespace`.
        const fs = await import("node:fs");
        fs.writeFileSync(
          `${tv.vaultDir}/alpha.md`,
          validNote("alpha", "Alpha", "Alpha updated.", "# Alpha\n\nUpdated content."),
        );
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    title: Root Schema\n    namespace: true\n    parent: root\n    children: [alpha]\n",
        );
        gitCommitAll(tv.dir, "alpha + schema namespace");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.mode).toBe("incremental");

        const rows = await conn.query(
          'MATCH (s:Schema {id: "root"}) RETURN s.title AS title, s.namespace AS ns',
        );
        const all = await rows.getAll();
        expect(all).toHaveLength(1);
        expect(all[0]?.title).toBe("Root Schema");
        expect(all[0]?.ns).toBe(true);
      });
    } finally {
      tv.cleanup();
    }
  });

  it("removes orphaned Tag/Audience nodes when the last referencing note is deleted", async () => {
    const tv = createTempVault({
      "vault/root.md": validNote("root", "Root", "Entry point."),
      "vault/alpha.md":
        "---\nid: alpha\ntitle: Alpha\ndesc: Alpha note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\ntags: [widgets]\naudience: [eng]\n---\n\n# Alpha\n",
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    });
    initGitRepo(tv.dir);
    gitCommitAll(tv.dir, "initial");

    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await withConnectionForConfig(config, async (conn) => {
        await buildIndexWithConnection(conn, config, {}, { embedder: createFakeEmbedder() });

        const fs = await import("node:fs");
        fs.unlinkSync(`${tv.vaultDir}/alpha.md`);
        fs.writeFileSync(
          `${tv.vaultDir}/root.schema.yml`,
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
        );
        gitCommitAll(tv.dir, "delete alpha");

        const result = await buildIndexWithConnection(
          conn,
          config,
          {},
          { embedder: createFakeEmbedder() },
        );
        expect(result.notesRemoved).toBe(1);

        const tagRows = await conn.query("MATCH (t:Tag) RETURN count(t) AS cnt");
        expect(Number((await tagRows.getAll())[0]?.cnt)).toBe(0);
        const audienceRows = await conn.query("MATCH (a:Audience) RETURN count(a) AS cnt");
        expect(Number((await audienceRows.getAll())[0]?.cnt)).toBe(0);
      });
    } finally {
      tv.cleanup();
    }
  });
});
