import type { Connection } from "@ladybugdb/core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type { AudienceEdge } from "../extract/audience.js";
import { extractAudienceEdges } from "../extract/audience.js";
import type { Chunk } from "../extract/chunking.js";
import { chunkNote } from "../extract/chunking.js";
import type { CodeRefEdge } from "../extract/code-refs.js";
import { extractCodeRefEdges } from "../extract/code-refs.js";
import type { HierarchyEdge } from "../extract/hierarchy.js";
import { extractHierarchyEdges } from "../extract/hierarchy.js";
import { extractSchemaEdges } from "../extract/schema-relations.js";
import type { TagEdge } from "../extract/tags.js";
import { extractTagEdges } from "../extract/tags.js";
import type { WikilinkEdge } from "../extract/wikilinks.js";
import { extractWikilinks } from "../extract/wikilinks.js";
import { formatIndexErrors, validateVaultNotes } from "../frontmatter.js";
import {
  createEmbedder,
  type Embedder,
  LocalEmbedderUnavailableError,
} from "../search/embedder.js";
import { getHeadSha } from "../search/git-diff.js";
import type { BuildIndexResult, Note, ResolvedConfig } from "../types.js";
import { readVault, type Vault } from "../vault.js";
import { dbFileForConfig, withConnectionForConfig } from "./connection.js";
import {
  countChunks,
  countNotes,
  deleteOrphanNodes,
  deleteNoteSubgraph,
  insertAudienceEdges,
  insertChunksBatch,
  insertCodeRefEdges,
  insertHeadingsBatch,
  insertHierarchyEdges,
  insertNotes,
  insertNoteSubgraph,
  insertSchemaEdges,
  insertTagEdges,
  insertWikilinkEdges,
  type NoteSubgraphEdges,
  updateChunkEmbeddings,
} from "./insert.js";
import {
  embedderMeta,
  indexMetaPath,
  isIndexStale,
  type IndexMeta,
  readIndexMeta,
  writeIndexMeta,
} from "./meta.js";
import {
  createSchema,
  createVectorIndex,
  dropSchema,
  repairFtsIndex,
  SCHEMA_VERSION,
} from "./schema.js";

export type IndexerDeps = { embedder?: Embedder };

export function hashNote(note: Note): string {
  return createHash("sha256")
    .update(JSON.stringify(note.fm))
    .update("\0")
    .update(note.body)
    .digest("hex");
}

export async function buildIndex(
  config: ResolvedConfig,
  options: { full?: boolean } = {},
  deps: IndexerDeps = {},
): Promise<BuildIndexResult> {
  // Snapshot BEFORE opening: openDatabase creates the file on open, so an existence check inside
  // the connection would always be true and a missing database would silently take the
  // incremental path (producing an empty index that never self-heals).
  const dbExisted = existsSync(dbFileForConfig(config));
  return withConnectionForConfig(config, async (conn) => {
    return buildIndexWithConnection(conn, config, { ...options, dbExisted }, deps);
  });
}

/**
 * Internal entry point that runs the build logic on an already-open connection. Exposed for
 * tests that need to perform multiple builds on the same database without paying LadybugDB
 * 0.18.2's flaky close/open cost between calls.
 *
 * `options.dbExisted` must be the pre-open existence of the database file when the caller opened
 * the connection itself; it defaults to true (safe for tests building on a fresh database).
 */
export async function buildIndexWithConnection(
  conn: Connection,
  config: ResolvedConfig,
  options: { full?: boolean; dbExisted?: boolean } = {},
  deps: IndexerDeps = {},
): Promise<BuildIndexResult> {
  const ownEmbedder = deps.embedder === undefined;
  let embedder: Embedder | undefined;
  try {
    const meta = readIndexMeta(config);
    const resolved = await resolveEmbedder(config, deps, meta);
    embedder = resolved.embedder;
    const { ftsOnly } = resolved;
    const dbFile = dbFileForConfig(config);
    const metaFile = indexMetaPath(config);

    const needsFull =
      options.full === true ||
      !meta ||
      isIndexStale(config, meta, embedder) ||
      options.dbExisted === false;

    if (needsFull) {
      return await runFullRebuild(conn, config, embedder, ftsOnly, dbFile, metaFile);
    }
    return await runIncrementalRebuild(conn, config, meta, embedder, ftsOnly, dbFile, metaFile);
  } finally {
    if (ownEmbedder && embedder?.close) {
      await embedder.close();
    }
  }
}

/**
 * Resolves the embedder for a build, degrading to an FTS-only index when the configured provider
 * is unavailable on this platform — but only when the existing index (if any) is already
 * FTS-only. Silently rebuilding a vector index as FTS-only would destroy the embeddings, so that
 * case fails with an actionable error instead.
 */
async function resolveEmbedder(
  config: ResolvedConfig,
  deps: IndexerDeps,
  meta: IndexMeta | undefined,
): Promise<{ embedder: Embedder | undefined; ftsOnly: boolean }> {
  if (deps.embedder) return { embedder: deps.embedder, ftsOnly: false };
  try {
    return { embedder: await createEmbedder(config.search.embedding), ftsOnly: false };
  } catch (error) {
    if (error instanceof LocalEmbedderUnavailableError) {
      if (meta?.embedding.kind === "embedder") {
        throw new Error(
          `semantic-layer index: ${error.message} The existing index has embeddings built with ` +
            `"${meta.embedding.id}"; re-run on a platform with a working embedder, or delete ` +
            "the index to rebuild it as FTS-only.",
        );
      }
      console.error(`semantic-layer index: ${error.message} Building an FTS-only index.`);
      return { embedder: undefined, ftsOnly: true };
    }
    throw error;
  }
}

async function runFullRebuild(
  conn: Connection,
  config: ResolvedConfig,
  embedder: Embedder | undefined,
  ftsOnly: boolean,
  dbFile: string,
  metaFile: string,
): Promise<BuildIndexResult> {
  const { vault, validNotes, codeRefEdges } = await readValidatedVault(config);

  await dropSchema(conn);
  await createSchema(conn, embedder?.dimensions);

  const chunks = [...validNotes.values()].flatMap((note) =>
    chunkNote(note, config.search.chunking),
  );
  const hierarchyEdges = extractHierarchyEdges(validNotes);
  const tagEdges = extractTagEdges(validNotes);
  const audienceEdges = extractAudienceEdges(validNotes);
  const schemaEdges = extractSchemaEdges(vault.schemas, validNotes);
  const wikilinkEdges = [...validNotes.values()].flatMap((note) => extractWikilinks(note));

  await insertNotes(conn, [...validNotes.values()]);
  await insertHeadingsBatch(conn, [...validNotes.values()]);
  await insertChunksBatch(conn, chunks);
  await insertTagEdges(conn, tagEdges);
  await insertAudienceEdges(conn, audienceEdges);
  await insertCodeRefEdges(conn, codeRefEdges);
  await insertSchemaEdges(conn, vault.schemas, schemaEdges);
  await insertHierarchyEdges(conn, hierarchyEdges);
  await insertWikilinkEdges(conn, wikilinkEdges);

  if (embedder) {
    const embeddings = await embedder.embedDocuments(chunks.map((c) => c.text));
    await updateChunkEmbeddings(conn, chunks, embeddings);
    // The HNSW index is built only now, in one bulk CREATE_VECTOR_INDEX pass over the populated
    // table: LadybugDB 0.18.2's incremental index-maintenance path (one HNSW insert per SET)
    // segfaults at scale — libvector OnDiskHNSWIndex::shrinkForNode null-derefs inside
    // simsimd_cos_f32_neon once the graph grows into the thousands (reproduced at ~5k chunks).
    // Incremental rebuilds keep the existing index; their per-run update volume stays small.
    await createVectorIndex(conn, embedder.dimensions);
  }

  await repairFtsIndex(conn);

  const noteContentHashes: Record<string, string> = {};
  for (const note of validNotes.values()) {
    noteContentHashes[note.id] = hashNote(note);
  }

  const noteCount = validNotes.size;
  const chunkCount = await countChunks(conn);

  writeIndexMeta(config, {
    schemaVersion: SCHEMA_VERSION,
    vaultDir: config.vaultDir,
    lastIndexedSha: getHeadSha(config.repoRoot),
    lastIndexedAt: new Date().toISOString(),
    embedding: embedderMeta(embedder),
    chunking: config.search.chunking,
    noteContentHashes,
  });

  return {
    mode: "full",
    ftsOnly,
    notesIndexed: noteCount,
    notesRemoved: 0,
    noteCount,
    chunkCount,
    dbFile,
    metaFile,
  };
}

async function runIncrementalRebuild(
  conn: Connection,
  config: ResolvedConfig,
  meta: IndexMeta,
  embedder: Embedder | undefined,
  ftsOnly: boolean,
  dbFile: string,
  metaFile: string,
): Promise<BuildIndexResult> {
  const { vault, validNotes, codeRefEdges } = await readValidatedVault(config);

  // Change detection is pure content reconciliation: any note whose hash changed or is new, plus
  // any hashed note that no longer exists. Git is deliberately not involved — the vault may be
  // untracked, partially committed, or rebased, and the index must still converge to the truth.
  const noteContentHashes = { ...meta.noteContentHashes };
  const changedNoteIds = new Set<string>();
  for (const note of validNotes.values()) {
    if (noteContentHashes[note.id] !== hashNote(note)) {
      changedNoteIds.add(note.id);
    }
  }
  let notesRemoved = 0;
  for (const id of Object.keys(noteContentHashes)) {
    if (!validNotes.has(id)) {
      changedNoteIds.add(id);
      notesRemoved += 1;
    }
  }

  for (const noteId of changedNoteIds) {
    await deleteNoteSubgraph(conn, noteId);
    delete noteContentHashes[noteId];
  }

  // Extract edge sets once; wikilink and hierarchy edges must include inbound relationships to
  // re-created notes after DETACH DELETE removes them.
  const hierarchyEdges = extractHierarchyEdges(validNotes);
  const wikilinkEdges = [...validNotes.values()].flatMap((note) => extractWikilinks(note));
  const tagEdges = extractTagEdges(validNotes);
  const audienceEdges = extractAudienceEdges(validNotes);
  const schemaChildEdges = extractSchemaEdges(vault.schemas, validNotes);

  const notesToReinsert = [...validNotes.values()].filter((note) => changedNoteIds.has(note.id));
  const chunksToEmbed: { note: Note; chunks: Chunk[] }[] = [];

  for (const note of notesToReinsert) {
    const chunks = chunkNote(note, config.search.chunking);
    const edges = buildNoteSubgraphEdges(
      note,
      hierarchyEdges,
      wikilinkEdges,
      tagEdges,
      audienceEdges,
      codeRefEdges,
    );
    await insertNoteSubgraph(conn, note, chunks, edges);
    chunksToEmbed.push({ note, chunks });
    noteContentHashes[note.id] = hashNote(note);
  }

  // Batch embed all changed chunks in one provider call.
  if (embedder && chunksToEmbed.length > 0) {
    const allTexts = chunksToEmbed.flatMap(({ chunks }) => chunks.map((chunk) => chunk.text));
    const allEmbeddings = await embedder.embedDocuments(allTexts);
    let offset = 0;
    for (const { chunks } of chunksToEmbed) {
      const embeddings = allEmbeddings.slice(offset, offset + chunks.length);
      await updateChunkEmbeddings(conn, chunks, embeddings);
      offset += chunks.length;
    }
  }

  // Schema files are not tracked by note hashes; refresh SCHEMA_CHILD edges on every incremental
  // run. The set is small and this guarantees schema-only edits take effect.
  await conn.query("MATCH ()-[r:SCHEMA_CHILD]->() DELETE r");
  await insertSchemaEdges(conn, vault.schemas, schemaChildEdges);

  await deleteOrphanNodes(conn);
  await repairFtsIndex(conn);

  const notesIndexed = notesToReinsert.length;
  const noteCount = await countNotes(conn);
  const chunkCount = await countChunks(conn);

  writeIndexMeta(config, {
    ...meta,
    lastIndexedSha: getHeadSha(config.repoRoot),
    lastIndexedAt: new Date().toISOString(),
    embedding: embedderMeta(embedder),
    chunking: config.search.chunking,
    noteContentHashes,
  });

  return {
    mode: "incremental",
    ftsOnly,
    notesIndexed,
    notesRemoved,
    noteCount,
    chunkCount,
    dbFile,
    metaFile,
  };
}

/**
 * The shared build prelude: read the vault, validate frontmatter, resolve code refs. Throws
 * with the full error list when anything is invalid — a partial index is never written.
 */
async function readValidatedVault(config: ResolvedConfig): Promise<{
  vault: Vault;
  validNotes: Map<string, Note>;
  codeRefEdges: CodeRefEdge[];
}> {
  const vault = readVault(config.vaultDir);
  const { validNotes, errors: frontmatterErrors } = validateVaultNotes(vault.notes);
  if (frontmatterErrors.length > 0) {
    throw new Error(formatIndexErrors(frontmatterErrors));
  }
  const { edges: codeRefEdges, errors: codeRefErrors } = await extractCodeRefEdges(
    validNotes,
    config.repoRoot,
  );
  if (codeRefErrors.length > 0) {
    throw new Error(formatIndexErrors(codeRefErrors));
  }
  return { vault, validNotes, codeRefEdges };
}

function buildNoteSubgraphEdges(
  note: Note,
  hierarchyEdges: HierarchyEdge[],
  wikilinkEdges: WikilinkEdge[],
  tagEdges: TagEdge[],
  audienceEdges: AudienceEdge[],
  codeRefEdges: CodeRefEdge[],
): NoteSubgraphEdges {
  const hierarchy = hierarchyEdges.filter((e) => e.parent === note.id || e.child === note.id);
  // Inbound wikilinks (other notes linking to this note) must be restored after DETACH DELETE.
  const wikilinks = wikilinkEdges.filter((e) => e.source === note.id || e.target === note.id);
  const tags = tagEdges.filter((e) => e.noteId === note.id);
  const audience = audienceEdges.filter((e) => e.noteId === note.id);
  const codeRefs = codeRefEdges.filter((e) => e.noteId === note.id);
  return { hierarchy, wikilinks, tags, audience, codeRefs };
}
