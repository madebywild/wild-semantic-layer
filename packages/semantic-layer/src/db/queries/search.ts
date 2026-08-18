import { existsSync } from "node:fs";
import {
  createEmbedder,
  describeConfiguredEmbedder,
  type Embedder,
} from "../../search/embedder.js";
import { candidateNoteIdsSinceSha, getHeadSha, isAncestorOfHead } from "../../search/git-diff.js";
import type {
  ResolvedConfig,
  SearchMode,
  SearchQueryOptions,
  SearchQueryResult,
} from "../../types.js";
import {
  dbFileForConfig,
  isCorruptionError,
  recoverCorruptIndex,
  type SqliteConnection,
  withConnectionForConfig,
} from "../connection.js";
import { buildIndex, buildIndexWithConnection } from "../indexer.js";
import {
  configStalenessReasons,
  embeddingStalenessReason,
  type IndexMeta,
  readIndexMeta,
} from "../meta.js";
import { clearSearchCache, getSearchCache, type CachedChunk, type CachedNote } from "./cache.js";

export type SearchQueryDeps = { embedder?: Embedder; connection?: SqliteConnection };

/** Cosine similarities below this did not meet the previous search relevance floor. */
const DEFAULT_VECTOR_SIMILARITY = 0.4;
/** Standard reciprocal-rank-fusion damping constant. */
const RRF_K = 60;

function candidateLimit(limit: number): number {
  return Math.max(limit * 5, 25);
}

/**
 * Queries the SQLite index. FTS stays in SQLite; vector search is an exact cosine scan over the
 * process cache because SQLite stores embeddings as Float32 BLOBs rather than using an ANN
 * extension. The cache is invalidated by SQLite's data_version across processes and explicitly
 * refreshed by the indexer after its successful transactions.
 */
export async function querySearch(
  config: ResolvedConfig,
  opts: SearchQueryOptions,
  deps: SearchQueryDeps = {},
): Promise<SearchQueryResult> {
  if (!config.search.enabled) {
    throw new Error("semantic-layer search: search is disabled (search.enabled: false)");
  }
  const mode = opts.mode ?? config.search.defaultMode;
  const dbFile = dbFileForConfig(config);
  const dbExisted = existsSync(dbFile);
  const ownEmbedder = deps.embedder === undefined;
  const embedder = deps.embedder;

  try {
    const runQuery = async (conn: SqliteConnection): Promise<SearchQueryResult> => {
      let meta = readIndexMeta(config, conn);
      let rebuilt = false;
      if (!dbExisted || !meta || opts.rebuild === true) {
        if (!dbExisted || !meta) {
          console.error("semantic-layer search: no index found yet; building one now.");
        }
        await buildIndexWithConnection(
          conn,
          config,
          { full: opts.rebuild === true, dbExisted },
          embedder ? { embedder } : {},
        );
        meta = readIndexMeta(config, conn);
        rebuilt = true;
      }
      if (!meta || !existsSync(dbFile)) {
        throw new Error("semantic-layer search: failed to build a search index");
      }

      const stale = !rebuilt && isIndexStaleForQuery(config, meta, embedder);
      if (stale) {
        console.error(
          "semantic-layer search: the vault has changed since the index was last built; results " +
            "may be stale. Run `semantic-layer index` or pass --rebuild to refresh.",
        );
      }

      const limit = opts.limit ?? config.search.defaultLimit;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`semantic-layer search: limit must be a positive integer, got ${limit}`);
      }
      const queryVector = await resolveQueryVector(config, meta, mode, opts.query, { embedder });

      let hits: RawHit[];
      if (mode === "fts") {
        hits = runFtsQuery(conn, opts, limit);
      } else if (!queryVector) {
        throw new Error(`semantic-layer search: ${mode} mode requires a query vector`);
      } else if (mode === "vector") {
        hits = getVectorHits(conn, dbFile, opts, queryVector, limit);
      } else {
        hits = runHybridQuery(conn, dbFile, opts, queryVector, limit);
      }
      return { mode, hits, stale, rebuilt };
    };

    try {
      return deps.connection
        ? await runQuery(deps.connection)
        : await withConnectionForConfig(config, runQuery);
    } catch (error) {
      // Search has always been allowed to build a missing index, so it alone can turn a physical
      // corruption error into a full derived-state rebuild. An injected connection belongs to
      // the caller and might not be pooled, so it is deliberately left for that caller to close.
      if (!isCorruptionError(error) || deps.connection) throw error;
      await recoverCorruptIndex(config);
      clearSearchCache(dbFile);
      await buildIndex(config, { full: true }, embedder ? { embedder } : {});
      return await withConnectionForConfig(config, runQuery);
    }
  } finally {
    if (ownEmbedder) await embedder?.close?.();
  }
}

function isIndexStaleForQuery(
  config: ResolvedConfig,
  meta: IndexMeta,
  embedder: Embedder | undefined,
): boolean {
  if (configStalenessReasons(config, meta).length > 0) return true;
  if (meta.embedding.kind === "embedder") {
    const expected = embedder
      ? { id: embedder.id, dimensions: embedder.dimensions }
      : describeConfiguredEmbedder(config.search.embedding);
    if (embeddingStalenessReason(meta, expected)) return true;
  }
  if (!meta.lastIndexedSha) return false;
  if (!getHeadSha(config.repoRoot)) return true;
  if (!isAncestorOfHead(config.repoRoot, meta.lastIndexedSha)) return true;
  return candidateNoteIdsSinceSha(config.repoRoot, config.vaultDir, meta.lastIndexedSha).length > 0;
}

async function resolveQueryVector(
  config: ResolvedConfig,
  meta: IndexMeta,
  mode: SearchMode,
  query: string,
  deps: SearchQueryDeps,
): Promise<number[] | undefined> {
  if (mode === "fts") return undefined;
  if (meta.embedding.kind === "fts-only") {
    throw new Error(
      `semantic-layer search: the index is FTS-only (no embedder was available when it was ` +
        `built); --mode ${mode} is unavailable. Fix the embedder and re-run \`semantic-layer ` +
        "index`, or use --mode fts.",
    );
  }
  const ownEmbedder = deps.embedder === undefined;
  const embedder = deps.embedder ?? (await createEmbedder(config.search.embedding));
  try {
    if (embedder.id !== meta.embedding.id || embedder.dimensions !== meta.embedding.dimensions) {
      throw new Error(
        `semantic-layer search: the index was built with embedder "${meta.embedding.id}" but ` +
          `the active config resolves to "${embedder.id}". Run \`semantic-layer index\` to rebuild ` +
          "with the current embedder before using --mode vector or hybrid.",
      );
    }
    return await embedder.embedQuery(query);
  } finally {
    if (ownEmbedder) await embedder.close?.();
  }
}

type RawHit = {
  id: string;
  noteId: string;
  headingPath: string;
  title: string;
  text: string;
  status: string;
  score: number;
};

type SqlParams = Record<string, string | number>;

/** SQL filters intentionally mirror the prior semantics: every supplied tag/audience is an OR. */
function buildFilters(opts: SearchQueryOptions): { where: string[]; params: SqlParams } {
  const where: string[] = [];
  const params: SqlParams = {};
  if (opts.status) {
    where.push("n.status = :status");
    params.status = opts.status;
  }
  if (opts.tags?.length) {
    const names = opts.tags.map((tag, index) => {
      const key = `tag_${index}`;
      params[key] = tag;
      return `:${key}`;
    });
    where.push(
      `EXISTS (SELECT 1 FROM note_tags filter_tag WHERE filter_tag.note_id = n.id AND filter_tag.tag IN (${names.join(", ")}))`,
    );
  }
  if (opts.audience?.length) {
    const names = opts.audience.map((audience, index) => {
      const key = `audience_${index}`;
      params[key] = audience;
      return `:${key}`;
    });
    where.push(
      `EXISTS (SELECT 1 FROM note_audiences filter_audience WHERE filter_audience.note_id = n.id AND filter_audience.audience IN (${names.join(", ")}))`,
    );
  }
  return { where, params };
}

function runFtsQuery(conn: SqliteConnection, opts: SearchQueryOptions, limit: number): RawHit[] {
  const { where, params } = buildFilters(opts);
  const rows = conn
    .prepare(
      `SELECT c.id, c.note_id AS noteId, c.heading_path AS headingPath, n.title, c.text, n.status,
              -bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN notes n ON n.id = c.note_id
        WHERE chunks_fts MATCH :term${where.length ? ` AND ${where.join(" AND ")}` : ""}
        ORDER BY score DESC, c.id
        LIMIT :limit`,
    )
    .all({ ...params, term: opts.query, limit }) as Record<string, unknown>[];
  return rows.map((row) => toRawHit(row, Number(row.score)));
}

function getVectorHits(
  conn: SqliteConnection,
  dbPath: string,
  opts: SearchQueryOptions,
  queryVector: number[],
  limit: number,
): RawHit[] {
  const cache = getSearchCache(conn, dbPath);
  const hits: RawHit[] = [];
  for (const chunk of cache.chunks.values()) {
    const note = cache.notes.get(chunk.noteId);
    if (!note || !matchesFilters(note, opts)) continue;
    const score = cosineSimilarity(queryVector, chunk.embedding);
    if (score >= DEFAULT_VECTOR_SIMILARITY) hits.push(toCachedHit(chunk, note, score));
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function runHybridQuery(
  conn: SqliteConnection,
  dbPath: string,
  opts: SearchQueryOptions,
  queryVector: number[],
  limit: number,
): RawHit[] {
  const candidates = candidateLimit(limit);
  const ftsRows = runFtsQuery(conn, opts, candidates);
  const vectorRows = getVectorHits(conn, dbPath, opts, queryVector, candidates);
  const fused = new Map<string, RawHit>();
  for (const rows of [ftsRows, vectorRows]) {
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(row.id);
      if (existing) existing.score += contribution;
      else fused.set(row.id, { ...row, score: contribution });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function matchesFilters(note: CachedNote, opts: SearchQueryOptions): boolean {
  if (opts.status && note.status !== opts.status) return false;
  if (opts.tags?.length && !opts.tags.some((tag) => note.tags.has(tag))) return false;
  if (opts.audience?.length && !opts.audience.some((audience) => note.audience.has(audience))) {
    return false;
  }
  return true;
}

function cosineSimilarity(query: number[], embedding: Float32Array): number {
  if (query.length !== embedding.length || query.length === 0) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let queryMagnitude = 0;
  let embeddingMagnitude = 0;
  for (let index = 0; index < query.length; index += 1) {
    const left = query[index] as number;
    const right = embedding[index] as number;
    dot += left * right;
    queryMagnitude += left * left;
    embeddingMagnitude += right * right;
  }
  if (queryMagnitude === 0 || embeddingMagnitude === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(queryMagnitude * embeddingMagnitude);
}

function toCachedHit(chunk: CachedChunk, note: CachedNote, score: number): RawHit {
  return {
    id: chunk.id,
    noteId: chunk.noteId,
    headingPath: chunk.headingPath,
    title: note.title,
    text: chunk.text,
    status: note.status,
    score,
  };
}

function toRawHit(row: Record<string, unknown>, score: number): RawHit {
  return {
    id: String(row.id),
    noteId: String(row.noteId),
    headingPath: String(row.headingPath),
    title: String(row.title),
    text: String(row.text),
    status: String(row.status),
    score,
  };
}
