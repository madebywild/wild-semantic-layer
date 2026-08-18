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
});
