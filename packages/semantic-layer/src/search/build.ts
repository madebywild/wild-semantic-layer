import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import {
  count as countDocuments,
  insertMultiple,
  removeMultiple,
  search as searchIndex,
} from "@orama/orama";
import { type LoadConfigOptions, loadConfig } from "../config.js";
import { validateNoteFrontmatter } from "../frontmatter.js";
import type { Note, ResolvedConfig } from "../types.js";
import { readVault, toIsoDate } from "../vault.js";
import { type Chunk, chunkNote } from "./chunking.js";
import { createEmbedder, type Embedder, FastEmbedUnavailableError } from "./embedder.js";
import { candidateNoteIdsSinceSha, getHeadSha, isAncestorOfHead } from "./git-diff.js";
import {
  isManifestCompatible,
  readManifest,
  type SearchIndexManifest,
  writeManifestAtomic,
} from "./manifest.js";
import { loadIndex, saveIndexAtomic } from "./persistence.js";
import {
  createEmptyIndex,
  SEARCH_SCHEMA_VERSION,
  type SearchDocument,
  type SearchIndex,
} from "./schema.js";

/** Placeholder identity recorded in the manifest when the embedder is unavailable and the index is FTS-only. */
export const FTS_ONLY_EMBEDDING_ID = "fts-only";
const FTS_ONLY_DIMENSIONS = 1;
/** No real vault note plausibly produces more chunks than this; bounds the "all chunks for a note" lookup. */
const MAX_CHUNKS_PER_NOTE = 10_000;

export type SearchBuildOptions = { full?: boolean };

export type SearchBuildResult = {
  mode: "full" | "incremental";
  ftsOnly: boolean;
  notesIndexed: number;
  notesRemoved: number;
  noteCount: number;
  chunkCount: number;
  indexFile: string;
  manifestFile: string;
};

export type SearchBuildDeps = { embedder?: Embedder };

/** Loads config from disk/CLI options, then builds or refreshes the search index. */
export function runSearchBuild(
  options: LoadConfigOptions & SearchBuildOptions = {},
): Promise<SearchBuildResult> {
  return searchBuildResolved(loadConfig(options), options);
}

/**
 * Builds or incrementally refreshes the search index for an already-resolved config. `deps.embedder`
 * is the dependency-injection seam that keeps tests network- and ONNX-free.
 */
export async function searchBuildResolved(
  config: ResolvedConfig,
  opts: SearchBuildOptions = {},
  deps: SearchBuildDeps = {},
): Promise<SearchBuildResult> {
  if (!config.search.enabled) {
    throw new Error("semantic-layer search-index: search is disabled (search.enabled: false)");
  }
  const indexFile = join(config.vaultDir, config.search.indexFile);
  const manifestFile = join(config.vaultDir, config.search.manifestFile);

  const validNotes = readValidNotes(config);
  const { embedder, ftsOnly } = await resolveEmbedder(config, deps);
  const dimensions = embedder?.dimensions ?? FTS_ONLY_DIMENSIONS;
  const embeddingId = embedder?.id ?? FTS_ONLY_EMBEDDING_ID;

  const existingManifest = readManifest(manifestFile);
  const plan = await planRebuild(config, indexFile, existingManifest, opts.full, {
    vaultDirRelative: vaultDirRelative(config),
    embeddingId,
    embeddingDimensions: dimensions,
    chunking: config.search.chunking,
  });

  const outcome =
    plan.mode === "incremental"
      ? await runIncrementalRebuild(config, validNotes, embedder, plan.existingIndex, plan.manifest)
      : await runFullRebuild(config, validNotes, embedder, dimensions);

  await saveIndexAtomic(outcome.index, indexFile);
  const manifest: SearchIndexManifest = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    vaultDirRelative: vaultDirRelative(config),
    lastIndexedSha: getHeadSha(config.repoRoot),
    lastIndexedAt: new Date().toISOString(),
    embedding: { id: embeddingId, dimensions },
    chunking: config.search.chunking,
    noteCount: Object.keys(outcome.noteContentHashes).length,
    chunkCount: countDocuments(outcome.index),
    noteContentHashes: outcome.noteContentHashes,
  };
  writeManifestAtomic(manifestFile, manifest);

  return {
    mode: plan.mode,
    ftsOnly,
    notesIndexed: outcome.notesIndexed,
    notesRemoved: outcome.notesRemoved,
    noteCount: manifest.noteCount,
    chunkCount: manifest.chunkCount,
    indexFile,
    manifestFile,
  };
}

type RebuildPlan =
  | { mode: "full" }
  | { mode: "incremental"; existingIndex: SearchIndex; manifest: SearchIndexManifest };

/**
 * Decides full vs. incremental per the documented fallback conditions, checked in order: an
 * explicit `--full`, a missing manifest or stored SHA, no git repo, the stored SHA no longer being
 * an ancestor of HEAD (rebase/squash/shallow clone), a manifest/config mismatch, or a missing
 * index file. Any of these makes an incremental rebuild unsafe, so they all fall back to full.
 */
async function planRebuild(
  config: ResolvedConfig,
  indexFile: string,
  manifest: SearchIndexManifest | undefined,
  full: boolean | undefined,
  current: Parameters<typeof isManifestCompatible>[1],
): Promise<RebuildPlan> {
  if (full || !manifest || !manifest.lastIndexedSha) return { mode: "full" };
  if (!getHeadSha(config.repoRoot)) return { mode: "full" };
  if (!isAncestorOfHead(config.repoRoot, manifest.lastIndexedSha)) return { mode: "full" };
  if (!isManifestCompatible(manifest, current)) return { mode: "full" };

  const existingIndex = await loadIndex(indexFile);
  if (!existingIndex) return { mode: "full" };
  return { mode: "incremental", existingIndex, manifest };
}

type RebuildOutcome = {
  index: SearchIndex;
  noteContentHashes: Record<string, string>;
  notesIndexed: number;
  notesRemoved: number;
};

async function runFullRebuild(
  config: ResolvedConfig,
  validNotes: Map<string, Note>,
  embedder: Embedder | undefined,
  dimensions: number,
): Promise<RebuildOutcome> {
  const index = createEmptyIndex(dimensions);
  const noteContentHashes: Record<string, string> = {};
  const entries: Array<{ chunk: Chunk; note: Note }> = [];

  for (const note of validNotes.values()) {
    noteContentHashes[note.id] = hashNote(note);
    for (const chunk of chunkNote(note, config.search.chunking)) entries.push({ chunk, note });
  }

  await insertDocuments(index, entries, embedder);
  return { index, noteContentHashes, notesIndexed: validNotes.size, notesRemoved: 0 };
}

/**
 * Recomputes chunks only for notes a git prefilter flagged as possibly changed since the last
 * build, reusing everything else untouched. A candidate is skipped entirely when its recomputed
 * content hash still matches the manifest — commit-boundary churn with unchanged content never
 * triggers a wasted re-embed.
 */
async function runIncrementalRebuild(
  config: ResolvedConfig,
  validNotes: Map<string, Note>,
  embedder: Embedder | undefined,
  index: SearchIndex,
  manifest: SearchIndexManifest,
): Promise<RebuildOutcome> {
  const sha = manifest.lastIndexedSha;
  if (!sha) throw new Error("incremental rebuild requires a manifest with a stored SHA");

  const candidateIds = new Set(candidateNoteIdsSinceSha(config.repoRoot, config.vaultDir, sha));

  const noteContentHashes = { ...manifest.noteContentHashes };
  const toReindex: Note[] = [];
  let notesRemoved = 0;

  for (const noteId of candidateIds) {
    const note = validNotes.get(noteId);
    if (!note) {
      if (noteId in noteContentHashes) {
        await removeNoteChunks(index, noteId);
        delete noteContentHashes[noteId];
        notesRemoved += 1;
      }
      continue;
    }

    const hash = hashNote(note);
    if (noteContentHashes[noteId] === hash) continue;

    await removeNoteChunks(index, noteId);
    noteContentHashes[noteId] = hash;
    toReindex.push(note);
  }

  // Batched in one embedDocuments call across every changed note, not one call per note — a
  // remote embedder (Gemini) would otherwise pay one round-trip per note instead of one for the
  // whole incremental batch.
  const entries = toReindex.flatMap((note) =>
    chunkNote(note, config.search.chunking).map((chunk) => ({ chunk, note })),
  );
  await insertDocuments(index, entries, embedder);

  return { index, noteContentHashes, notesIndexed: toReindex.length, notesRemoved };
}

async function removeNoteChunks(index: SearchIndex, noteId: string): Promise<void> {
  const existing = await searchIndex(index, {
    term: "",
    where: { noteId: { eq: noteId } },
    limit: MAX_CHUNKS_PER_NOTE,
  });
  if (existing.hits.length > 0) {
    await removeMultiple(
      index,
      existing.hits.map((hit) => hit.id),
    );
  }
}

async function insertDocuments(
  index: SearchIndex,
  entries: Array<{ chunk: Chunk; note: Note }>,
  embedder: Embedder | undefined,
): Promise<void> {
  if (entries.length === 0) return;
  const vectors = embedder
    ? await embedder.embedDocuments(entries.map((entry) => entry.chunk.text))
    : undefined;
  const documents = entries.map(({ chunk, note }, i) =>
    toSearchDocument(chunk, note, vectors?.[i]),
  );
  await insertMultiple(index, documents);
}

function toSearchDocument(
  chunk: Chunk,
  note: Note,
  embedding: number[] | undefined,
): SearchDocument {
  return {
    id: chunk.id,
    noteId: chunk.noteId,
    chunkIndex: chunk.chunkIndex,
    headingPath: chunk.headingPath,
    title: note.fm.title,
    text: chunk.text,
    status: note.fm.status,
    tags: note.fm.tags ?? [],
    audience: note.fm.audience ?? [],
    owner: note.fm.owner,
    lastVerified: toIsoDate(note.fm.last_verified),
    modality: "text",
    ...(embedding ? { embedding } : {}),
  };
}

/** Reads the vault and keeps only notes whose frontmatter validates — matching `check`'s trust gate. */
function readValidNotes(config: ResolvedConfig): Map<string, Note> {
  const { notes } = readVault(config.vaultDir);
  const valid = new Map<string, Note>();
  for (const note of notes.values()) {
    const parsed = validateNoteFrontmatter(note);
    if (!parsed.ok) continue;
    note.fm = parsed.frontmatter;
    valid.set(note.id, note);
  }
  return valid;
}

/** Content hash covering both frontmatter and body, so a tags/status/audience-only edit still counts as a change. */
function hashNote(note: Note): string {
  return createHash("sha256")
    .update(JSON.stringify(note.fm))
    .update(" ")
    .update(note.body)
    .digest("hex");
}

async function resolveEmbedder(
  config: ResolvedConfig,
  deps: SearchBuildDeps,
): Promise<{ embedder: Embedder | undefined; ftsOnly: boolean }> {
  if (deps.embedder) return { embedder: deps.embedder, ftsOnly: false };
  try {
    return { embedder: await createEmbedder(config.search.embedding), ftsOnly: false };
  } catch (error) {
    if (!(error instanceof FastEmbedUnavailableError)) throw error;
    console.error(`semantic-layer search-index: ${error.message} Building an FTS-only index.`);
    return { embedder: undefined, ftsOnly: true };
  }
}

/** The vault directory's path relative to the repo root, POSIX-normalized for stable manifest comparisons. */
export function vaultDirRelative(config: ResolvedConfig): string {
  return relative(config.repoRoot, config.vaultDir).split(sep).join("/");
}
