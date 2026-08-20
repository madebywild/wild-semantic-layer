import type { AudienceEdge } from "../extract/audience.js";
import type { Chunk } from "../extract/chunking.js";
import type { CodeRefEdge } from "../extract/code-refs.js";
import type { HierarchyEdge } from "../extract/hierarchy.js";
import type { SchemaChildEdge } from "../extract/schema-relations.js";
import type { TagEdge } from "../extract/tags.js";
import type { WikilinkEdge } from "../extract/wikilinks.js";
import type { Note, SchemaDoc } from "../types.js";
import { toIsoDate } from "../vault.js";
import type { SqliteConnection } from "./connection.js";
import { sqlCount } from "./sql.js";

export type NoteSubgraphEdges = {
  hierarchy: HierarchyEdge[];
  wikilinks: WikilinkEdge[];
  tags: TagEdge[];
  audience: AudienceEdge[];
  codeRefs: CodeRefEdge[];
};

export function deleteNoteSubgraph(conn: SqliteConnection, noteId: string): void {
  conn.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
}

export function insertNoteSubgraph(
  conn: SqliteConnection,
  note: Note,
  chunks: Chunk[],
  edges: NoteSubgraphEdges,
): void {
  insertNotes(conn, [note]);
  insertHeadingsBatch(conn, [note]);
  insertChunksBatch(conn, chunks);
  insertTagEdges(conn, edges.tags);
  insertAudienceEdges(conn, edges.audience);
  insertCodeRefEdges(conn, edges.codeRefs);
  insertHierarchyEdges(conn, edges.hierarchy);
  insertWikilinkEdges(conn, edges.wikilinks);
}

export function deleteOrphanNodes(conn: SqliteConnection): void {
  conn.exec(`
    DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM note_tags WHERE note_tags.tag = tags.name);
    DELETE FROM audiences WHERE NOT EXISTS (SELECT 1 FROM note_audiences WHERE note_audiences.audience = audiences.name);
    DELETE FROM code_symbols WHERE NOT EXISTS (
      SELECT 1 FROM note_code_references WHERE note_code_references.code_symbol_id = code_symbols.id
    );
  `);
}

export function insertNotes(conn: SqliteConnection, notes: Note[]): void {
  const statement = conn.prepare(`
    INSERT INTO notes(id, title, description, status, owner, last_verified, ttl_days, file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const note of notes) {
    statement.run(
      note.id,
      note.fm.title,
      note.fm.desc,
      note.fm.status,
      note.fm.owner,
      toIsoDate(note.fm.last_verified),
      note.fm.ttl_days,
      note.file,
    );
  }
}

export function insertHeadingsBatch(conn: SqliteConnection, notes: Note[]): void {
  const statement = conn.prepare(
    "INSERT INTO headings(id, note_id, slug, text, level) VALUES (?, ?, ?, ?, ?)",
  );
  for (const note of notes) {
    note.headingSpans.forEach((heading, index) => {
      statement.run(
        `${note.id}#${heading.slug}-${index}`,
        note.id,
        heading.slug,
        heading.text,
        heading.level,
      );
    });
  }
}

export function insertChunksBatch(conn: SqliteConnection, chunks: Chunk[]): void {
  const statement = conn.prepare(`
    INSERT INTO chunks(id, note_id, chunk_index, heading_path, text, search_text, modality)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const chunk of chunks) {
    statement.run(
      chunk.id,
      chunk.noteId,
      chunk.chunkIndex,
      chunk.headingPath,
      chunk.text,
      chunk.text.replace(/\s*\n+\s*/g, " "),
      "text",
    );
  }
}

export function insertTagEdges(conn: SqliteConnection, edges: TagEdge[]): void {
  const insertTag = conn.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)");
  const insertEdge = conn.prepare("INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?, ?)");
  for (const edge of edges) {
    insertTag.run(edge.tag);
    insertEdge.run(edge.noteId, edge.tag);
  }
}

export function insertAudienceEdges(conn: SqliteConnection, edges: AudienceEdge[]): void {
  const insertAudience = conn.prepare("INSERT OR IGNORE INTO audiences(name) VALUES (?)");
  const insertEdge = conn.prepare(
    "INSERT OR IGNORE INTO note_audiences(note_id, audience) VALUES (?, ?)",
  );
  for (const edge of edges) {
    insertAudience.run(edge.audience);
    insertEdge.run(edge.noteId, edge.audience);
  }
}

export function insertCodeRefEdges(conn: SqliteConnection, edges: CodeRefEdge[]): void {
  const insertSymbol = conn.prepare(`
    INSERT INTO code_symbols(id, file, symbol, kind) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET file = excluded.file, symbol = excluded.symbol, kind = excluded.kind
  `);
  const insertEdge = conn.prepare(
    "INSERT OR IGNORE INTO note_code_references(note_id, code_symbol_id) VALUES (?, ?)",
  );
  for (const edge of edges) {
    insertSymbol.run(edge.symbolId, edge.file, edge.symbol, edge.kind);
    insertEdge.run(edge.noteId, edge.symbolId);
  }
}

export function insertSchemaEdges(
  conn: SqliteConnection,
  schemas: Map<string, SchemaDoc>,
  edges: SchemaChildEdge[],
): void {
  const info = buildSchemaInfo(schemas);
  const insertSchema = conn.prepare(`
    INSERT INTO schemas(id, title, namespace) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, namespace = excluded.namespace
  `);
  const insertEdge = conn.prepare(
    "INSERT OR IGNORE INTO schema_children(schema_id, note_id) VALUES (?, ?)",
  );
  for (const [id, schema] of info) {
    insertSchema.run(id, schema.title ?? "", Number(schema.namespace ?? false));
  }
  for (const edge of edges) {
    insertEdge.run(edge.schemaId, edge.childId);
  }
}

function buildSchemaInfo(
  schemas: Map<string, SchemaDoc>,
): Map<string, { title?: string; namespace?: boolean }> {
  const info = new Map<string, { title?: string; namespace?: boolean }>();
  for (const doc of schemas.values()) {
    for (const schema of doc.schemas ?? []) info.set(schema.id, schema);
  }
  return info;
}

export function insertHierarchyEdges(conn: SqliteConnection, edges: HierarchyEdge[]): void {
  const statement = conn.prepare(
    "INSERT OR IGNORE INTO hierarchy_edges(parent_id, child_id) VALUES (?, ?)",
  );
  for (const edge of edges) statement.run(edge.parent, edge.child);
}

export function insertWikilinkEdges(conn: SqliteConnection, edges: WikilinkEdge[]): void {
  // Validation resolves every endpoint before a write transaction begins. Foreign keys remain a
  // final integrity guard; `OR IGNORE` only deduplicates repeated links to the same heading.
  const statement = conn.prepare(
    "INSERT OR IGNORE INTO links(source_id, target_id, anchor) VALUES (?, ?, ?)",
  );
  for (const edge of edges) {
    statement.run(edge.source, edge.target, edge.anchor ?? "");
  }
}

export function updateChunkEmbeddings(
  conn: SqliteConnection,
  chunks: Chunk[],
  embeddings: number[][],
): void {
  const statement = conn.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
  chunks.forEach((chunk, index) => {
    const embedding = embeddings[index];
    if (!embedding) throw new Error(`missing embedding for chunk ${chunk.id}`);
    statement.run(Buffer.from(new Float32Array(embedding).buffer), chunk.id);
  });
}

export function countNotes(conn: SqliteConnection): number {
  return sqlCount(conn, "SELECT count(*) AS cnt FROM notes", "cnt");
}

export function countChunks(conn: SqliteConnection): number {
  return sqlCount(conn, "SELECT count(*) AS cnt FROM chunks", "cnt");
}
