import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashNote, buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import {
  deleteNoteSubgraph,
  insertNoteSubgraph,
} from "../../../../../packages/semantic-layer/src/db/insert.js";
import { createVectorIndex } from "../../../../../packages/semantic-layer/src/db/schema.js";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempDir,
  createTempVault,
} from "../../../../helpers.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";

function validNote(id: string, body = `# ${id}\n\nContent.`): Note {
  return {
    id,
    file: `/tmp/${id}.md`,
    fm: {
      id,
      title: id,
      desc: `${id} note.`,
      status: "active",
      owner: "tester@example.com",
      last_verified: "2026-05-13",
      ttl_days: 365,
    },
    body,
    headings: new Set([id.toLowerCase()]),
    headingSpans: [{ text: id, slug: id.toLowerCase(), level: 1, offset: 0 }],
  };
}

describe.sequential("indexer", () => {
  it("hashNote returns a stable sha256 hash", () => {
    const note = validNote("root");
    const first = hashNote(note);
    const second = hashNote(note);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashNote changes when frontmatter or body changes", () => {
    const note = validNote("root");
    const original = hashNote(note);
    note.fm.title = "changed";
    expect(hashNote(note)).not.toBe(original);
  });

  it("insertNoteSubgraph inserts a note, headings, chunks and edges", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
      await withConnectionForConfig(config, async (conn) => {
        await createVectorIndex(conn, 8);

        // Create target notes so hierarchy and wikilink edges have endpoints.
        const targetNote = validNote("child");
        const targetStmt = await conn.prepare(`
          CREATE (n:Note {id: $id, title: $title, \`desc\`: $description, status: $status, owner: $owner, lastVerified: $lastVerified, ttlDays: $ttlDays, file: $file})
        `);
        for (const n of [targetNote]) {
          await conn.execute(targetStmt, {
            id: n.id,
            title: n.fm.title,
            description: n.fm.desc,
            status: n.fm.status,
            owner: n.fm.owner,
            lastVerified: n.fm.last_verified,
            ttlDays: n.fm.ttl_days,
            file: n.file,
          });
        }

        const note = validNote("root");
        const chunks = [
          { id: "root", noteId: "root", chunkIndex: 0, headingPath: "", text: "Root\nRoot note." },
          {
            id: "root#root",
            noteId: "root",
            chunkIndex: 1,
            headingPath: "Root",
            text: "Root\n\n# Root\n\nContent.",
          },
        ];
        await insertNoteSubgraph(conn, note, chunks, {
          hierarchy: [{ parent: "root", child: "child" }],
          wikilinks: [{ source: "root", target: "child", anchor: "section" }],
          tags: [{ noteId: "root", tag: "test" }],
          audience: [{ noteId: "root", audience: "agent" }],
          codeRefs: [
            {
              noteId: "root",
              symbolId: "src/mod.ts#foo",
              file: "src/mod.ts",
              symbol: "foo",
              kind: "function",
            },
          ],
        });

        const noteResult = await conn.query('MATCH (n:Note {id: "root"}) RETURN n.title AS title');
        expect((await noteResult.getAll())[0]?.title).toBe("root");

        const chunkResult = await conn.query(
          'MATCH (c:Chunk {noteId: "root"}) RETURN count(c) AS cnt',
        );
        expect(Number((await chunkResult.getAll())[0]?.cnt)).toBe(2);

        const headingResult = await conn.query(
          'MATCH (h:Heading {noteId: "root"}) RETURN count(h) AS cnt',
        );
        expect(Number((await headingResult.getAll())[0]?.cnt)).toBe(1);

        const tagResult = await conn.query(
          'MATCH (t:Tag {name: "test"})<-[:HAS_TAG]-(:Note) RETURN t.name AS name',
        );
        expect((await tagResult.getAll())[0]?.name).toBe("test");

        const childResult = await conn.query(
          'MATCH (root:Note {id: "root"})-[:HAS_CHILD]->(child:Note {id: "child"}) RETURN child.id AS id',
        );
        expect((await childResult.getAll())[0]?.id).toBe("child");

        const linkResult = await conn.query(
          'MATCH (root:Note {id: "root"})-[:LINKS_TO]->(child:Note {id: "child"}) RETURN root.id AS id',
        );
        expect((await linkResult.getAll())[0]?.id).toBe("root");
      });
    } finally {
      cleanup();
    }
  });

  it("deleteNoteSubgraph removes a note and its chunks and headings", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
      await withConnectionForConfig(config, async (conn) => {
        await createVectorIndex(conn, 8);
        const note = validNote("root");
        const chunks = [
          { id: "root", noteId: "root", chunkIndex: 0, headingPath: "", text: "text" },
        ];
        await insertNoteSubgraph(conn, note, chunks, {
          hierarchy: [],
          wikilinks: [],
          tags: [],
          audience: [],
          codeRefs: [],
          schemaChildren: [],
        });

        await deleteNoteSubgraph(conn, "root");

        const noteResult = await conn.query('MATCH (n:Note {id: "root"}) RETURN count(n) AS cnt');
        expect(Number((await noteResult.getAll())[0]?.cnt)).toBe(0);
        const chunkResult = await conn.query(
          'MATCH (c:Chunk {noteId: "root"}) RETURN count(c) AS cnt',
        );
        expect(Number((await chunkResult.getAll())[0]?.cnt)).toBe(0);
        const headingResult = await conn.query(
          'MATCH (h:Heading {noteId: "root"}) RETURN count(h) AS cnt',
        );
        expect(Number((await headingResult.getAll())[0]?.cnt)).toBe(0);
      });
    } finally {
      cleanup();
    }
  });

  it("buildIndex performs a full rebuild and writes metadata", async () => {
    const tv = createTempVault({
      "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n# Root\n\nContent.\n`,
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });
    try {
      const result = await buildIndex(
        createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir }),
        {},
        { embedder: createFakeEmbedder() },
      );
      expect(result.mode).toBe("full");
      expect(result.noteCount).toBe(1);
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(existsSync(result.metaFile)).toBe(true);
      const meta = JSON.parse(readFileSync(result.metaFile, "utf8"));
      expect(meta.schemaVersion).toBeDefined();
    } finally {
      tv.cleanup();
    }
  });
});
