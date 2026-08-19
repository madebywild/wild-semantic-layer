import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../packages/semantic-layer/src/db/connection.js";
import {
  createSchema,
  repairFtsIndex,
  validateFtsIntegrity,
} from "../../../../../packages/semantic-layer/src/db/schema.js";
import { createTempDir } from "../../../../helpers.js";

describe("SQLite schema", () => {
  it("maintains external-content FTS through insert, update, and delete triggers", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const db = openDatabase(`${dir}/vault.sqlite`);
      createSchema(db);
      const ftsCount = (term: string) =>
        Number(
          (
            db
              .prepare("SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?")
              .get(term) as { count: number }
          ).count,
        );
      db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "root",
        "Root",
        "Root note",
        "active",
        "owner",
        "2026-08-18",
        90,
        "root.md",
      );
      db.prepare(
        "INSERT INTO chunks (id, note_id, chunk_index, heading_path, text, search_text, modality) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("root#0", "root", 0, "", "first unique term", "first unique term", "text");
      expect(ftsCount("unique")).toBe(1);
      db.prepare("UPDATE chunks SET search_text = ? WHERE id = ?").run("second phrase", "root#0");
      expect(ftsCount("unique")).toBe(0);
      expect(ftsCount("second")).toBe(1);
      db.prepare("DELETE FROM chunks WHERE id = ?").run("root#0");
      expect(ftsCount("second")).toBe(0);
      validateFtsIntegrity(db);
      repairFtsIndex(db);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("detects an external-content FTS mismatch and repairs it from chunks", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const db = openDatabase(`${dir}/vault.sqlite`);
      createSchema(db);
      db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "root",
        "Root",
        "Root note",
        "active",
        "owner",
        "2026-08-18",
        90,
        "root.md",
      );
      db.prepare(
        "INSERT INTO chunks (id, note_id, chunk_index, heading_path, text, search_text, modality) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("root#0", "root", 0, "", "repair token", "repair token", "text");
      const rowid = Number(
        (db.prepare("SELECT rowid FROM chunks WHERE id = ?").get("root#0") as { rowid: number })
          .rowid,
      );
      db.prepare(
        "INSERT INTO chunks_fts(chunks_fts, rowid, search_text) VALUES ('delete', ?, ?)",
      ).run(rowid, "repair token");
      expect(() => validateFtsIntegrity(db)).toThrow();
      repairFtsIndex(db);
      validateFtsIntegrity(db);
      expect(
        Number(
          (
            db
              .prepare("SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?")
              .get("repair") as { count: number }
          ).count,
        ),
      ).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });
});
