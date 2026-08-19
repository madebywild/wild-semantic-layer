import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  clearSearchCache,
  getSearchCache,
  refreshSearchCache,
} from "../../../../../packages/semantic-layer/src/db/queries/cache.js";
import { createSchema } from "../../../../../packages/semantic-layer/src/db/schema.js";
import { createTempDir } from "../../../../helpers.js";

function insertNote(
  db: ReturnType<typeof openDatabase>,
  id: string,
  title: string,
  embedding: number[],
): void {
  db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    title,
    `${title} description`,
    "active",
    "owner",
    "2026-08-18",
    90,
    `${id}.md`,
  );
  db.prepare(
    `INSERT INTO chunks
      (id, note_id, chunk_index, heading_path, text, search_text, modality, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${id}#0`,
    id,
    0,
    "",
    `${title} text`,
    `${title} text`,
    "text",
    Buffer.from(new Float32Array(embedding).buffer),
  );
}

describe("SQLite search cache", () => {
  it("refreshes changed notes in place and reloads after an external commit", () => {
    const { dir, cleanup } = createTempDir();
    const dbPath = `${dir}/vault.sqlite`;
    const first = openDatabase(dbPath);
    try {
      createSchema(first);
      insertNote(first, "root", "Root", [1, 0]);

      const initial = getSearchCache(first, dbPath);
      expect(initial.notes.get("root")?.title).toBe("Root");

      first.exec("BEGIN IMMEDIATE");
      insertNote(first, "alpha", "Alpha", [0, 1]);
      first.exec("COMMIT");
      refreshSearchCache(first, dbPath, ["alpha"]);

      const incrementallyRefreshed = getSearchCache(first, dbPath);
      expect(incrementallyRefreshed).toBe(initial);
      expect(incrementallyRefreshed.notes.get("alpha")?.title).toBe("Alpha");
      expect([...incrementallyRefreshed.chunks.keys()]).toContain("alpha#0");

      first.prepare("DELETE FROM notes WHERE id = ?").run("alpha");
      refreshSearchCache(first, dbPath, ["alpha"]);
      expect(getSearchCache(first, dbPath)).toBe(initial);
      expect(initial.notes.has("alpha")).toBe(false);
      expect(initial.chunks.has("alpha#0")).toBe(false);

      const external = openDatabase(dbPath);
      external.prepare("UPDATE notes SET title = ? WHERE id = ?").run("Externally changed", "root");
      external.close();

      const externallyReloaded = getSearchCache(first, dbPath);
      expect(externallyReloaded).not.toBe(incrementallyRefreshed);
      expect(externallyReloaded.notes.get("root")?.title).toBe("Externally changed");
    } finally {
      clearSearchCache(dbPath);
      first.close();
      cleanup();
    }
  });

  it("reloads fully, accepts an empty incremental change set, and clears every cache", () => {
    const { dir, cleanup } = createTempDir();
    const dbPath = `${dir}/vault.sqlite`;
    const db = openDatabase(dbPath);
    try {
      createSchema(db);
      insertNote(db, "root", "Root", [1, 0]);
      db.prepare("INSERT INTO tags(name) VALUES (?)").run("docs");
      db.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?, ?)").run("root", "docs");
      db.prepare("INSERT INTO audiences(name) VALUES (?)").run("agents");
      db.prepare("INSERT INTO note_audiences(note_id, audience) VALUES (?, ?)").run(
        "root",
        "agents",
      );

      const initial = getSearchCache(db, dbPath);
      expect(initial.notes.get("root")?.tags).toEqual(new Set(["docs"]));
      expect(initial.notes.get("root")?.audience).toEqual(new Set(["agents"]));
      refreshSearchCache(db, dbPath, []);
      expect(getSearchCache(db, dbPath)).toBe(initial);
      refreshSearchCache(db, dbPath);
      expect(getSearchCache(db, dbPath)).not.toBe(initial);

      clearSearchCache();
      expect(getSearchCache(db, dbPath)).not.toBe(initial);
    } finally {
      clearSearchCache();
      db.close();
      cleanup();
    }
  });

  it("rejects a malformed embedding blob instead of scoring corrupt vector data", () => {
    const { dir, cleanup } = createTempDir();
    const dbPath = `${dir}/vault.sqlite`;
    const db = openDatabase(dbPath);
    try {
      createSchema(db);
      db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "root",
        "Root",
        "Root description",
        "active",
        "owner",
        "2026-08-18",
        90,
        "root.md",
      );
      db.prepare(
        "INSERT INTO chunks (id, note_id, chunk_index, heading_path, text, search_text, modality, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("root#0", "root", 0, "", "text", "text", "text", Buffer.from([1, 2, 3]));
      expect(() => getSearchCache(db, dbPath)).toThrow(/invalid Float32 embedding BLOB/);
    } finally {
      clearSearchCache(dbPath);
      db.close();
      cleanup();
    }
  });
});
