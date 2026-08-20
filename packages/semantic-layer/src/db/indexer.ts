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
import { extractVaultWikilinks } from "../extract/wikilinks.js";
import { formatIndexErrors, validateVaultNotes } from "../frontmatter.js";
import {
  createEmbedder,
  type Embedder,
  LocalEmbedderUnavailableError,
} from "../search/embedder.js";
import { getHeadSha } from "../search/git-diff.js";
import type { Note, ResolvedConfig } from "../types.js";
import { readVault, type Vault } from "../vault.js";
import {
  dbFileForConfig,
  isCorruptionError,
  legacyIndexArtifacts,
  recoverCorruptIndex,
  type SqliteConnection,
  withConnectionForConfig,
} from "./connection.js";
import {
  countChunks,
  countNotes,
  deleteNoteSubgraph,
  deleteOrphanNodes,
  insertAudienceEdges,
  insertChunksBatch,
  insertCodeRefEdges,
  insertHeadingsBatch,
  insertHierarchyEdges,
  insertNotes,
  insertSchemaEdges,
  insertTagEdges,
  insertWikilinkEdges,
  type NoteSubgraphEdges,
  updateChunkEmbeddings,
} from "./insert.js";
import {
  embedderMeta,
  type IndexMeta,
  isIndexStale,
  readBooleanMetadata,
  readIndexMeta,
  writeBooleanMetadata,
  writeIndexMeta,
} from "./meta.js";
import { createSchema, dropSchema, SCHEMA_VERSION, validateFtsIntegrity } from "./schema.js";

export type IndexerDeps = { embedder?: Embedder };

/** Operational build data used by the CLI; public `BuildIndexResult` is intentionally smaller. */
export type IndexBuildResult = {
  mode: "full" | "incremental";
  ftsOnly: boolean;
  notesIndexed: number;
  notesRemoved: number;
  noteCount: number;
  chunkCount: number;
  indexPath: string;
  legacyMigrationNotice: boolean;
};

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
): Promise<IndexBuildResult> {
  const dbExisted = existsSync(dbFileForConfig(config));
  try {
    return await withConnectionForConfig(config, (conn) =>
      buildIndexWithConnection(conn, config, { ...options, dbExisted }, deps),
    );
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    await recoverCorruptIndex(config);
    const { clearSearchCache } = await import("./queries/cache.js");
    clearSearchCache(dbFileForConfig(config));
    // A corrupt derived database has no trustworthy incremental baseline.
    return withConnectionForConfig(config, (conn) =>
      buildIndexWithConnection(conn, config, { full: true, dbExisted: false }, deps),
    );
  }
}

export async function buildIndexWithConnection(
  conn: SqliteConnection,
  config: ResolvedConfig,
  options: { full?: boolean; dbExisted?: boolean } = {},
  deps: IndexerDeps = {},
): Promise<IndexBuildResult> {
  const ownEmbedder = deps.embedder === undefined;
  let embedder: Embedder | undefined;
  try {
    const meta = readIndexMeta(config, conn);
    const resolved = await resolveEmbedder(config, deps, meta);
    embedder = resolved.embedder;
    const needsFull =
      options.full === true ||
      !meta ||
      isIndexStale(config, meta, embedder) ||
      options.dbExisted === false;
    return needsFull
      ? await runFullRebuild(conn, config, embedder, resolved.ftsOnly)
      : await runIncrementalRebuild(conn, config, meta, embedder, resolved.ftsOnly);
  } finally {
    if (ownEmbedder) await embedder?.close?.();
  }
}

async function resolveEmbedder(
  config: ResolvedConfig,
  deps: IndexerDeps,
  meta: IndexMeta | undefined,
): Promise<{ embedder: Embedder | undefined; ftsOnly: boolean }> {
  if (deps.embedder) return { embedder: deps.embedder, ftsOnly: false };
  try {
    return { embedder: await createEmbedder(config.search.embedding), ftsOnly: false };
  } catch (error) {
    if (!(error instanceof LocalEmbedderUnavailableError)) throw error;
    if (meta?.embedding.kind === "embedder") {
      throw new Error(
        `semantic-layer index: ${error.message} The existing index has embeddings built with "${meta.embedding.id}"; re-run on a platform with a working embedder.`,
      );
    }
    console.error(`semantic-layer index: ${error.message} Building an FTS-only index.`);
    return { embedder: undefined, ftsOnly: true };
  }
}

type PreparedVault = {
  vault: Vault;
  validNotes: Map<string, Note>;
  codeRefEdges: CodeRefEdge[];
  chunksByNote: Map<string, Chunk[]>;
  hierarchyEdges: HierarchyEdge[];
  wikilinkEdges: WikilinkEdge[];
  tagEdges: TagEdge[];
  audienceEdges: AudienceEdge[];
};

/** All potentially slow/fallible work, especially embedding, finishes before BEGIN. */
async function prepareVault(config: ResolvedConfig): Promise<PreparedVault> {
  const { vault, validNotes, codeRefEdges, wikilinkEdges } = await readValidatedVault(config);
  const chunksByNote = new Map(
    [...validNotes.values()].map((note) => [note.id, chunkNote(note, config.search.chunking)]),
  );
  return {
    vault,
    validNotes,
    codeRefEdges,
    chunksByNote,
    hierarchyEdges: extractHierarchyEdges(validNotes),
    wikilinkEdges,
    tagEdges: extractTagEdges(validNotes),
    audienceEdges: extractAudienceEdges(validNotes),
  };
}

/** Generates only the vectors that the pending transaction will write. */
async function embedChunks(
  embedder: Embedder | undefined,
  chunksByNote: Map<string, Chunk[]>,
): Promise<Map<string, number[][]>> {
  if (!embedder) return new Map();
  const chunks = [...chunksByNote.values()].flat();
  if (chunks.length === 0) return new Map();
  const embeddings = await embedder.embedDocuments(chunks.map((chunk) => chunk.text));
  if (embeddings.length !== chunks.length) {
    throw new Error(`embedder returned ${embeddings.length} vectors for ${chunks.length} chunks`);
  }
  const byNote = new Map<string, number[][]>();
  let offset = 0;
  for (const [noteId, noteChunks] of chunksByNote) {
    byNote.set(noteId, embeddings.slice(offset, offset + noteChunks.length));
    offset += noteChunks.length;
  }
  return byNote;
}

async function runFullRebuild(
  conn: SqliteConnection,
  config: ResolvedConfig,
  embedder: Embedder | undefined,
  ftsOnly: boolean,
): Promise<IndexBuildResult> {
  const prepared = await prepareVault(config);
  const embeddingsByNote = await embedChunks(embedder, prepared.chunksByNote);
  const noteContentHashes = hashesFor(prepared.validNotes);
  const legacyCandidate = legacyIndexArtifacts(config).length > 0;
  const priorMigrationNotice =
    readBooleanMetadata(conn, "legacy_migration_notice_emitted") === true;
  let legacyMigrationNotice = false;
  transaction(conn, () => {
    dropSchema(conn);
    createSchema(conn);
    insertAll(conn, prepared, embeddingsByNote);
    legacyMigrationNotice = legacyCandidate && !priorMigrationNotice;
    if (legacyCandidate) writeBooleanMetadata(conn, "legacy_migration_notice_emitted", true);
    writeIndexMeta(buildMeta(config, embedder, noteContentHashes), conn);
    validateFtsIntegrity(conn);
  });
  await refreshCache(conn, dbFileForConfig(config));
  drainWal(conn);
  return result(conn, "full", ftsOnly, prepared.validNotes.size, 0, config, legacyMigrationNotice);
}

async function runIncrementalRebuild(
  conn: SqliteConnection,
  config: ResolvedConfig,
  meta: IndexMeta,
  embedder: Embedder | undefined,
  ftsOnly: boolean,
): Promise<IndexBuildResult> {
  const prepared = await prepareVault(config);
  const changed = new Set<string>();
  const noteContentHashes = { ...meta.noteContentHashes };
  for (const note of prepared.validNotes.values())
    if (noteContentHashes[note.id] !== hashNote(note)) changed.add(note.id);
  let notesRemoved = 0;
  for (const id of Object.keys(noteContentHashes)) {
    if (!prepared.validNotes.has(id)) {
      changed.add(id);
      notesRemoved += 1;
    }
  }
  const changedIds = [...changed];
  const changedNotes = [...prepared.validNotes.values()].filter((note) => changed.has(note.id));
  const embeddingsByNote = await embedChunks(
    embedder,
    new Map(changedNotes.map((note) => [note.id, prepared.chunksByNote.get(note.id) ?? []])),
  );
  transaction(conn, () => {
    for (const id of changedIds) {
      deleteNoteSubgraph(conn, id);
      delete noteContentHashes[id];
    }
    // Restore every node before any relationship. A batch may change both ends of a link or
    // hierarchy edge; foreign keys make the old incremental one-note-at-a-time order invalid.
    insertNotes(conn, changedNotes);
    insertHeadingsBatch(conn, changedNotes);
    const changedChunks = changedNotes.flatMap((note) => prepared.chunksByNote.get(note.id) ?? []);
    insertChunksBatch(conn, changedChunks);
    if (embedder) {
      for (const note of changedNotes) {
        const chunks = prepared.chunksByNote.get(note.id) ?? [];
        updateChunkEmbeddings(conn, chunks, embeddingsByNote.get(note.id) ?? []);
      }
    }
    for (const note of changedNotes) {
      insertEdgesForNote(conn, prepared, note);
      noteContentHashes[note.id] = hashNote(note);
    }
    conn.exec("DELETE FROM schemas");
    insertSchemaEdges(
      conn,
      prepared.vault.schemas,
      extractSchemaEdges(prepared.vault.schemas, prepared.validNotes),
    );
    deleteOrphanNodes(conn);
    writeIndexMeta(buildMeta(config, embedder, noteContentHashes), conn);
    validateFtsIntegrity(conn);
  });
  await refreshCache(conn, dbFileForConfig(config), changedIds);
  drainWal(conn);
  return result(
    conn,
    "incremental",
    ftsOnly,
    changedIds.length - notesRemoved,
    notesRemoved,
    config,
    false,
  );
}

function transaction(conn: SqliteConnection, fn: () => void): void {
  conn.exec("BEGIN IMMEDIATE");
  try {
    fn();
    conn.exec("COMMIT");
  } catch (error) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      // Preserve the originating error.
    }
    throw error;
  }
}

/** A committed index must be complete in vault.sqlite without requiring its WAL sidecar. */
function drainWal(conn: SqliteConnection): void {
  const checkpoint = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy?: number; log?: number }
    | undefined;
  if (Number(checkpoint?.busy ?? 0) !== 0 || Number(checkpoint?.log ?? 0) !== 0) {
    throw new Error("semantic-layer index: SQLite WAL checkpoint did not fully drain");
  }
}

function insertAll(
  conn: SqliteConnection,
  prepared: PreparedVault,
  embeddingsByNote: Map<string, number[][]>,
): void {
  insertNotes(conn, [...prepared.validNotes.values()]);
  insertHeadingsBatch(conn, [...prepared.validNotes.values()]);
  insertChunksBatch(conn, [...prepared.chunksByNote.values()].flat());
  if (embeddingsByNote.size > 0) {
    for (const [noteId, chunks] of prepared.chunksByNote) {
      updateChunkEmbeddings(conn, chunks, embeddingsByNote.get(noteId) ?? []);
    }
  }
  insertTagEdges(conn, prepared.tagEdges);
  insertAudienceEdges(conn, prepared.audienceEdges);
  insertCodeRefEdges(conn, prepared.codeRefEdges);
  insertSchemaEdges(
    conn,
    prepared.vault.schemas,
    extractSchemaEdges(prepared.vault.schemas, prepared.validNotes),
  );
  insertHierarchyEdges(conn, prepared.hierarchyEdges);
  insertWikilinkEdges(conn, prepared.wikilinkEdges);
}

function insertEdgesForNote(conn: SqliteConnection, prepared: PreparedVault, note: Note): void {
  const edges = subgraphEdges(note, prepared);
  insertTagEdges(conn, edges.tags);
  insertAudienceEdges(conn, edges.audience);
  insertCodeRefEdges(conn, edges.codeRefs);
  insertHierarchyEdges(conn, edges.hierarchy);
  insertWikilinkEdges(conn, edges.wikilinks);
}

function subgraphEdges(note: Note, prepared: PreparedVault): NoteSubgraphEdges {
  return {
    hierarchy: prepared.hierarchyEdges.filter(
      (edge) => edge.parent === note.id || edge.child === note.id,
    ),
    wikilinks: prepared.wikilinkEdges.filter(
      (edge) => edge.source === note.id || edge.target === note.id,
    ),
    tags: prepared.tagEdges.filter((edge) => edge.noteId === note.id),
    audience: prepared.audienceEdges.filter((edge) => edge.noteId === note.id),
    codeRefs: prepared.codeRefEdges.filter((edge) => edge.noteId === note.id),
  };
}

function buildMeta(
  config: ResolvedConfig,
  embedder: Embedder | undefined,
  noteContentHashes: Record<string, string>,
): IndexMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    vaultDir: config.vaultDir,
    lastIndexedSha: getHeadSha(config.repoRoot),
    lastIndexedAt: new Date().toISOString(),
    embedding: embedderMeta(embedder),
    chunking: config.search.chunking,
    wikilinks: config.wikilinks,
    noteContentHashes,
  };
}

function hashesFor(notes: Map<string, Note>): Record<string, string> {
  return Object.fromEntries([...notes.values()].map((note) => [note.id, hashNote(note)]));
}

function result(
  conn: SqliteConnection,
  mode: "full" | "incremental",
  ftsOnly: boolean,
  notesIndexed: number,
  notesRemoved: number,
  config: ResolvedConfig,
  legacyMigrationNotice: boolean,
): IndexBuildResult {
  return {
    mode,
    ftsOnly,
    notesIndexed,
    notesRemoved,
    noteCount: countNotes(conn),
    chunkCount: countChunks(conn),
    indexPath: dbFileForConfig(config),
    legacyMigrationNotice,
  };
}

async function refreshCache(
  conn: SqliteConnection,
  dbPath: string,
  changedNoteIds?: string[],
): Promise<void> {
  const { clearSearchCache, refreshSearchCache } = await import("./queries/cache.js");
  try {
    refreshSearchCache(conn, dbPath, changedNoteIds);
  } catch (error) {
    clearSearchCache(dbPath);
    throw error;
  }
}

async function readValidatedVault(config: ResolvedConfig): Promise<{
  vault: Vault;
  validNotes: Map<string, Note>;
  codeRefEdges: CodeRefEdge[];
  wikilinkEdges: WikilinkEdge[];
}> {
  const vault = readVault(config.vaultDir);
  const { validNotes, errors: frontmatterErrors } = validateVaultNotes(vault.notes);
  if (frontmatterErrors.length > 0) throw new Error(formatIndexErrors(frontmatterErrors));
  const { edges: codeRefEdges, errors: codeRefErrors } = await extractCodeRefEdges(
    validNotes,
    config.repoRoot,
  );
  if (codeRefErrors.length > 0) throw new Error(formatIndexErrors(codeRefErrors));
  const wikilinks = extractVaultWikilinks(validNotes, config.wikilinks);
  if (wikilinks.errors.length > 0) throw new Error(formatIndexErrors(wikilinks.errors));
  return { vault, validNotes, codeRefEdges, wikilinkEdges: wikilinks.edges };
}
