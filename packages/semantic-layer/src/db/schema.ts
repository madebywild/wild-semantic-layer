import type { SqliteConnection } from "./connection.js";

export const SCHEMA_VERSION = 5;
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;
export const FTS_INDEX_NAME = "chunks_fts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  owner TEXT NOT NULL, last_verified TEXT NOT NULL, ttl_days INTEGER NOT NULL, file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, heading_path TEXT NOT NULL, text TEXT NOT NULL,
  search_text TEXT NOT NULL, modality TEXT NOT NULL, embedding BLOB,
  UNIQUE(note_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS chunks_note_id_idx ON chunks(note_id);
CREATE TABLE IF NOT EXISTS headings (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, text TEXT NOT NULL, level INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS headings_note_id_idx ON headings(note_id);
CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
  PRIMARY KEY(note_id, tag)
);
CREATE TABLE IF NOT EXISTS audiences (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS note_audiences (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  audience TEXT NOT NULL REFERENCES audiences(name) ON DELETE CASCADE,
  PRIMARY KEY(note_id, audience)
);
CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_code_references (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  code_symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  PRIMARY KEY(note_id, code_symbol_id)
);
CREATE TABLE IF NOT EXISTS schemas (id TEXT PRIMARY KEY, title TEXT NOT NULL, namespace INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schema_children (
  schema_id TEXT NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY(schema_id, note_id)
);
CREATE TABLE IF NOT EXISTS hierarchy_edges (
  parent_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY(parent_id, child_id)
);
CREATE TABLE IF NOT EXISTS links (
  source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  -- Empty string preserves an absent public anchor while making edge uniqueness total.
  anchor TEXT NOT NULL DEFAULT '',
  UNIQUE(source_id, target_id, anchor)
);
CREATE INDEX IF NOT EXISTS links_target_idx ON links(target_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  search_text, content='chunks', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF search_text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
`;

export function createSchema(conn: SqliteConnection, _dimensions?: number): void {
  conn.exec(SCHEMA_SQL);
}

export function dropSchema(conn: SqliteConnection): void {
  conn.exec(`
    DROP TRIGGER IF EXISTS chunks_fts_insert;
    DROP TRIGGER IF EXISTS chunks_fts_delete;
    DROP TRIGGER IF EXISTS chunks_fts_update;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS links;
    DROP TABLE IF EXISTS hierarchy_edges;
    DROP TABLE IF EXISTS schema_children;
    DROP TABLE IF EXISTS schemas;
    DROP TABLE IF EXISTS note_code_references;
    DROP TABLE IF EXISTS code_symbols;
    DROP TABLE IF EXISTS note_audiences;
    DROP TABLE IF EXISTS audiences;
    DROP TABLE IF EXISTS note_tags;
    DROP TABLE IF EXISTS tags;
    DROP TABLE IF EXISTS headings;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS metadata;
  `);
}

/** FTS5's built-in consistency check; callers invoke it inside their write transaction. */
export function validateFtsIntegrity(conn: SqliteConnection): void {
  conn.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)").run();
}

/** Rebuild is available for explicit repair, not required after normal trigger-maintained writes. */
export function repairFtsIndex(conn: SqliteConnection): void {
  conn.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
  validateFtsIntegrity(conn);
}
