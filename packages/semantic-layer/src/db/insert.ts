import type { Connection } from "@ladybugdb/core";

import type { AudienceEdge } from "../extract/audience.js";
import type { Chunk } from "../extract/chunking.js";
import type { CodeRefEdge } from "../extract/code-refs.js";
import type { HierarchyEdge } from "../extract/hierarchy.js";
import type { SchemaChildEdge } from "../extract/schema-relations.js";
import type { TagEdge } from "../extract/tags.js";
import type { WikilinkEdge } from "../extract/wikilinks.js";
import type { Note, SchemaDoc } from "../types.js";
import { toIsoDate } from "../vault.js";
import { queryCount, queryRows } from "./cypher.js";

export type NoteSubgraphEdges = {
  hierarchy: HierarchyEdge[];
  wikilinks: WikilinkEdge[];
  tags: TagEdge[];
  audience: AudienceEdge[];
  codeRefs: CodeRefEdge[];
};

export async function deleteNoteSubgraph(conn: Connection, noteId: string): Promise<void> {
  await queryRows(
    conn,
    `MATCH (n:Note {id: $id})
     OPTIONAL MATCH (n)-[:CONTAINS_CHUNK]->(c:Chunk)
     OPTIONAL MATCH (n)-[:HAS_HEADING]->(h:Heading)
     DETACH DELETE n, c, h`,
    { id: noteId },
  );
}

/**
 * Inserts one note with its headings, chunks, and edges using the same UNWIND batch helpers as
 * full rebuilds, so single-note inserts never drift. SCHEMA_CHILD edges are deliberately not
 * handled here: incremental rebuilds refresh them globally (schema files are not content-hashed).
 */
export async function insertNoteSubgraph(
  conn: Connection,
  note: Note,
  chunks: Chunk[],
  edges: NoteSubgraphEdges,
): Promise<void> {
  await insertNotes(conn, [note]);
  await insertHeadingsBatch(conn, [note]);
  await insertChunksBatch(conn, chunks);
  await insertTagEdges(conn, edges.tags);
  await insertAudienceEdges(conn, edges.audience);
  await insertCodeRefEdges(conn, edges.codeRefs);
  await insertHierarchyEdges(conn, edges.hierarchy);
  await insertWikilinkEdges(conn, edges.wikilinks);
}

/**
 * Removes Tag/Audience/CodeSymbol nodes that no note references anymore. DETACH DELETE drops a
 * note's edges but leaves these shared nodes behind; without this they would accumulate forever.
 */
export async function deleteOrphanNodes(conn: Connection): Promise<void> {
  for (const [label, rel] of [
    ["Tag", "HAS_TAG"],
    ["Audience", "HAS_AUDIENCE"],
    ["CodeSymbol", "DECLARES_CODE_REF"],
  ] as const) {
    await queryRows(
      conn,
      `MATCH (n:${label}) WHERE NOT EXISTS { MATCH (:Note)-[:${rel}]->(n) } DELETE n`,
    );
  }
}

export async function insertNotes(conn: Connection, notes: Note[]): Promise<void> {
  if (notes.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     CREATE (n:Note {
       id: row.id,
       title: row.title,
       \`desc\`: row.description,
       status: row.status,
       owner: row.owner,
       lastVerified: row.lastVerified,
       ttlDays: row.ttlDays,
       file: row.file
     })`,
    {
      rows: notes.map((note) => ({
        id: note.id,
        title: note.fm.title,
        description: note.fm.desc,
        status: note.fm.status,
        owner: note.fm.owner,
        lastVerified: toIsoDate(note.fm.last_verified),
        ttlDays: note.fm.ttl_days,
        file: note.file,
      })),
    },
  );
}

export async function insertHeadingsBatch(conn: Connection, notes: Note[]): Promise<void> {
  const rows = notes.flatMap((note) =>
    note.headingSpans.map((heading, index) => ({
      id: `${note.id}#${heading.slug}-${index}`,
      noteId: note.id,
      slug: heading.slug,
      text: heading.text,
      level: heading.level,
    })),
  );
  if (rows.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     CREATE (h:Heading {id: row.id, noteId: row.noteId, slug: row.slug, text: row.text, level: row.level})`,
    { rows },
  );
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (n:Note {id: row.noteId}), (h:Heading {id: row.id})
     CREATE (n)-[:HAS_HEADING]->(h)`,
    { rows },
  );
}

export async function insertChunksBatch(conn: Connection, chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     CREATE (c:Chunk {
       id: row.id,
       noteId: row.noteId,
       chunkIndex: row.chunkIndex,
       headingPath: row.headingPath,
       text: row.text,
       searchText: row.searchText,
       modality: row.modality
     })`,
    {
      rows: chunks.map((chunk) => ({
        id: chunk.id,
        noteId: chunk.noteId,
        chunkIndex: chunk.chunkIndex,
        headingPath: chunk.headingPath,
        text: chunk.text,
        // LadybugDB 0.18.2's FTS tokenizer does not treat newlines as separators — tokens
        // adjacent to line breaks fuse into unsearchable compounds. The FTS index runs over
        // this newline-normalized copy; `text` stays pristine for display.
        searchText: chunk.text.replace(/\s*\n+\s*/g, " "),
        modality: "text",
      })),
    },
  );
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (n:Note {id: row.noteId}), (c:Chunk {id: row.id})
     CREATE (n)-[:CONTAINS_CHUNK]->(c)`,
    { rows: chunks.map((chunk) => ({ noteId: chunk.noteId, id: chunk.id })) },
  );
}

export async function insertTagEdges(conn: Connection, edges: TagEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const tags = [...new Set(edges.map((e) => e.tag))].map((tag) => ({ tag }));
  await queryRows(conn, "UNWIND $rows AS row MERGE (t:Tag {name: row.tag})", { rows: tags });
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (n:Note {id: row.noteId}), (t:Tag {name: row.tag})
     CREATE (n)-[:HAS_TAG]->(t)`,
    { rows: edges.map((e) => ({ noteId: e.noteId, tag: e.tag })) },
  );
}

export async function insertAudienceEdges(conn: Connection, edges: AudienceEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const audiences = [...new Set(edges.map((e) => e.audience))].map((name) => ({ name }));
  await queryRows(conn, "UNWIND $rows AS row MERGE (a:Audience {name: row.name})", {
    rows: audiences,
  });
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (n:Note {id: row.noteId}), (a:Audience {name: row.name})
     CREATE (n)-[:HAS_AUDIENCE]->(a)`,
    { rows: edges.map((e) => ({ noteId: e.noteId, name: e.audience })) },
  );
}

export async function insertCodeRefEdges(conn: Connection, edges: CodeRefEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const symbols = [
    ...new Map(
      edges.map((e) => [
        e.symbolId,
        { id: e.symbolId, file: e.file, symbol: e.symbol, kind: e.kind },
      ]),
    ).values(),
  ];
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MERGE (s:CodeSymbol {id: row.id})
     ON CREATE SET s.file = row.file, s.symbol = row.symbol, s.kind = row.kind`,
    { rows: symbols },
  );
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (n:Note {id: row.noteId}), (s:CodeSymbol {id: row.symbolId})
     CREATE (n)-[:DECLARES_CODE_REF]->(s)`,
    { rows: edges.map((e) => ({ noteId: e.noteId, symbolId: e.symbolId })) },
  );
}

export async function insertSchemaEdges(
  conn: Connection,
  schemas: Map<string, SchemaDoc>,
  edges: SchemaChildEdge[],
): Promise<void> {
  if (edges.length === 0) return;
  const schemaInfo = buildSchemaInfo(schemas);
  const schemaRows = [...new Set(edges.map((e) => e.schemaId))].map((id) => ({
    id,
    title: schemaInfo.get(id)?.title ?? "",
    namespace: schemaInfo.get(id)?.namespace ?? false,
  }));
  // SET after MERGE applies to created and matched nodes alike, so a schema whose title or
  // namespace changed since the node was first created is corrected, not just created.
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MERGE (s:Schema {id: row.id})
     SET s.title = row.title, s.namespace = row.namespace`,
    { rows: schemaRows },
  );
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (s:Schema {id: row.schemaId}), (n:Note {id: row.childId})
     CREATE (s)-[:SCHEMA_CHILD]->(n)`,
    { rows: edges.map((e) => ({ schemaId: e.schemaId, childId: e.childId })) },
  );
}

function buildSchemaInfo(
  schemas: Map<string, SchemaDoc>,
): Map<string, { title?: string; namespace?: boolean }> {
  const info = new Map<string, { title?: string; namespace?: boolean }>();
  for (const doc of schemas.values()) {
    for (const schema of doc.schemas ?? []) {
      info.set(schema.id, { title: schema.title, namespace: schema.namespace });
    }
  }
  return info;
}

export async function insertHierarchyEdges(
  conn: Connection,
  edges: HierarchyEdge[],
): Promise<void> {
  if (edges.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (parent:Note {id: row.parent}), (child:Note {id: row.child})
     CREATE (parent)-[:HAS_CHILD]->(child)`,
    { rows: edges.map((e) => ({ parent: e.parent, child: e.child })) },
  );
}

export async function insertWikilinkEdges(conn: Connection, edges: WikilinkEdge[]): Promise<void> {
  if (edges.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (source:Note {id: row.source}), (target:Note {id: row.target})
     CREATE (source)-[:LINKS_TO {anchor: row.anchor}]->(target)`,
    { rows: edges.map((e) => ({ source: e.source, target: e.target, anchor: e.anchor ?? null })) },
  );
}

export async function updateChunkEmbeddings(
  conn: Connection,
  chunks: Chunk[],
  embeddings: number[][],
): Promise<void> {
  if (chunks.length === 0) return;
  await queryRows(
    conn,
    `UNWIND $rows AS row
     MATCH (c:Chunk {id: row.id})
     SET c.embedding = row.embedding`,
    {
      rows: chunks.map((chunk, i) => {
        const embedding = embeddings[i];
        if (!embedding) throw new Error(`missing embedding for chunk ${chunk.id}`);
        return { id: chunk.id, embedding };
      }),
    },
  );
}

export async function countNotes(conn: Connection): Promise<number> {
  return queryCount(conn, "MATCH (n:Note) RETURN count(n) AS cnt", "cnt");
}

export async function countChunks(conn: Connection): Promise<number> {
  return queryCount(conn, "MATCH (c:Chunk) RETURN count(c) AS cnt", "cnt");
}
