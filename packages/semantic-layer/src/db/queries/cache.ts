import type { SqliteConnection } from "../connection.js";

export type CachedChunk = {
  id: string;
  noteId: string;
  headingPath: string;
  text: string;
  embedding: Float32Array;
};

export type CachedNote = {
  id: string;
  title: string;
  status: string;
  tags: Set<string>;
  audience: Set<string>;
};

export type SearchCache = {
  dataVersion: number;
  chunks: Map<string, CachedChunk>;
  notes: Map<string, CachedNote>;
};

const searchCaches = new Map<string, SearchCache>();

/**
 * Returns this process's vector/filter cache. SQLite increments data_version when another
 * connection commits, so a long-lived process reloads automatically after an external writer.
 */
export function getSearchCache(conn: SqliteConnection, dbPath: string): SearchCache {
  const current = searchCaches.get(dbPath);
  const dataVersion = getDataVersion(conn);
  if (!current || current.dataVersion !== dataVersion) {
    const cache = loadSearchCache(conn, dataVersion);
    searchCaches.set(dbPath, cache);
    return cache;
  }
  return current;
}

/**
 * Called by the indexer only after a successful index transaction commits. Passing changed ids
 * keeps the hot cache incremental; omitted ids are used for full rebuilds and force a reload.
 */
export function refreshSearchCache(
  conn: SqliteConnection,
  dbPath: string,
  changedNoteIds?: Iterable<string>,
): void {
  const current = searchCaches.get(dbPath);
  const dataVersion = getDataVersion(conn);
  if (!current || !changedNoteIds) {
    searchCaches.set(dbPath, loadSearchCache(conn, dataVersion));
    return;
  }

  const ids = [...new Set(changedNoteIds)];
  if (ids.length === 0) {
    current.dataVersion = dataVersion;
    return;
  }
  for (const id of ids) {
    current.notes.delete(id);
    for (const [chunkId, chunk] of current.chunks) {
      if (chunk.noteId === id) current.chunks.delete(chunkId);
    }
  }
  loadNotes(conn, current.notes, ids);
  loadChunks(conn, current.chunks, ids);
  current.dataVersion = dataVersion;
}

/** Removes a cache after an index file was quarantined or a caller wants deterministic cleanup. */
export function clearSearchCache(dbPath?: string): void {
  if (dbPath) searchCaches.delete(dbPath);
  else searchCaches.clear();
}

function loadSearchCache(conn: SqliteConnection, dataVersion: number): SearchCache {
  const cache: SearchCache = { dataVersion, chunks: new Map(), notes: new Map() };
  loadNotes(conn, cache.notes);
  loadChunks(conn, cache.chunks);
  return cache;
}

function loadNotes(conn: SqliteConnection, notes: Map<string, CachedNote>, ids?: string[]): void {
  const clause = ids ? inClause("note", ids) : undefined;
  if (ids?.length === 0) return;
  const noteStatement = conn.prepare(
    `SELECT id, title, status FROM notes${clause ? ` WHERE id IN (${clause.sql})` : ""}`,
  );
  const noteRows = (clause ? noteStatement.all(clause.params) : noteStatement.all()) as Record<
    string,
    unknown
  >[];
  for (const row of noteRows) {
    const id = String(row.id);
    notes.set(id, {
      id,
      title: String(row.title),
      status: String(row.status),
      tags: new Set(),
      audience: new Set(),
    });
  }

  const tagStatement = conn.prepare(
    `SELECT note_id, tag FROM note_tags${clause ? ` WHERE note_id IN (${clause.sql})` : ""}`,
  );
  const tagRows = (clause ? tagStatement.all(clause.params) : tagStatement.all()) as Record<
    string,
    unknown
  >[];
  for (const row of tagRows) notes.get(String(row.note_id))?.tags.add(String(row.tag));

  const audienceStatement = conn.prepare(
    `SELECT note_id, audience FROM note_audiences${clause ? ` WHERE note_id IN (${clause.sql})` : ""}`,
  );
  const audienceRows = (
    clause ? audienceStatement.all(clause.params) : audienceStatement.all()
  ) as Record<string, unknown>[];
  for (const row of audienceRows)
    notes.get(String(row.note_id))?.audience.add(String(row.audience));
}

function loadChunks(
  conn: SqliteConnection,
  chunks: Map<string, CachedChunk>,
  ids?: string[],
): void {
  const clause = ids ? inClause("note", ids) : undefined;
  if (ids?.length === 0) return;
  const chunkStatement = conn.prepare(
    `SELECT id, note_id, heading_path, text, embedding
       FROM chunks
      WHERE embedding IS NOT NULL${clause ? ` AND note_id IN (${clause.sql})` : ""}`,
  );
  const rows = (clause ? chunkStatement.all(clause.params) : chunkStatement.all()) as Record<
    string,
    unknown
  >[];
  for (const row of rows) {
    const id = String(row.id);
    chunks.set(id, {
      id,
      noteId: String(row.note_id),
      headingPath: String(row.heading_path),
      text: String(row.text),
      embedding: blobToFloat32(row.embedding),
    });
  }
}

function inClause(
  prefix: string,
  values: string[],
): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const placeholders = values.map((value, index) => {
    const name = `${prefix}_${index}`;
    params[name] = value;
    return `:${name}`;
  });
  return { sql: placeholders.join(", "), params };
}

function getDataVersion(conn: SqliteConnection): number {
  const row = conn.prepare("PRAGMA data_version").get() as { data_version?: number } | undefined;
  return Number(row?.data_version ?? 0);
}

function blobToFloat32(blob: unknown): Float32Array {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : blob instanceof ArrayBuffer
        ? new Uint8Array(blob)
        : undefined;
  if (!bytes || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("semantic-layer search: invalid Float32 embedding BLOB in SQLite index");
  }
  // Copy to own aligned storage: a SQLite result buffer can be released after this statement.
  return new Float32Array(bytes.slice().buffer);
}
