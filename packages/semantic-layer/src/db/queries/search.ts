import type { Connection } from "@ladybugdb/core";
import { existsSync } from "node:fs";
import {
  createEmbedder,
  describeConfiguredEmbedder,
  type Embedder,
  FastEmbedUnavailableError,
} from "../../search/embedder.js";
import { candidateNoteIdsSinceSha, getHeadSha, isAncestorOfHead } from "../../search/git-diff.js";
import type {
  ResolvedConfig,
  SearchMode,
  SearchQueryOptions,
  SearchQueryResult,
} from "../../types.js";
import { dbFileForConfig, withConnectionForConfig } from "../connection.js";
import { queryRows } from "../cypher.js";
import { buildIndexWithConnection } from "../indexer.js";
import {
  configStalenessReasons,
  embeddingStalenessReason,
  type IndexMeta,
  readIndexMeta,
} from "../meta.js";
import { FTS_INDEX_NAME, VECTOR_INDEX_NAME } from "../schema.js";

export type SearchQueryDeps = { embedder?: Embedder; connection?: Connection };

/**
 * The similarity cutoff from the Orama-based search: Orama's own default (0.8) assumes
 * near-duplicate-level cosine similarity, while real sentence-embedding models score genuinely
 * relevant matches around 0.6–0.75. LadybugDB's HNSW index returns cosine *distance*, so the
 * equivalent cutoff is `distance <= 1 - similarity`, applied as a post-filter after the ANN scan.
 */
const DEFAULT_VECTOR_SIMILARITY = 0.4;
const VECTOR_DISTANCE_RADIUS = 1 - DEFAULT_VECTOR_SIMILARITY;

/** RRF damping constant for hybrid fusion (the standard k=60 from the original RRF paper). */
const RRF_K = 60;

/**
 * How many candidates the vector side fetches before the radius filter and limit are applied.
 * HNSW needs its k up front, so we over-fetch to leave enough room for post-filtering.
 */
function candidateLimit(limit: number): number {
  return Math.max(limit * 5, 25);
}

/**
 * Runs a search query against the vault's LadybugDB index, building it first on a cold start or
 * when `opts.rebuild` is set. `deps.embedder` is the dependency-injection seam that keeps tests
 * network- and ONNX-free.
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

  let meta = readIndexMeta(config);
  const willBuild = !existsSync(dbFile) || !meta || opts.rebuild === true;

  // If this query needs a vector AND a build is about to run, resolve the embedder once here and
  // reuse it for both — otherwise the build step and the query-embedding step would each load
  // their own native ONNX session, doubling model-load latency and memory for no benefit.
  const ownEmbedder = deps.embedder === undefined;
  let embedder = deps.embedder;
  try {
    if (mode !== "fts" && willBuild && !embedder) {
      try {
        embedder = await createEmbedder(config.search.embedding);
      } catch (error) {
        // Leave embedder undefined and let buildIndex's own resolution hit (and gracefully degrade
        // to FTS-only from) this same unavailability below, instead of failing the whole query over
        // a platform limitation the indexer already knows how to handle.
        if (!(error instanceof FastEmbedUnavailableError)) throw error;
      }
    }

    // Run the optional build and the query inside a single connection. LadybugDB 0.18.2's native
    // close is not fully synchronous; avoiding a separate open/close cycle for the build step
    // removes a major source of WAL checkpoint races in rapid search queries.
    const runQuery = async (conn: Connection): Promise<SearchQueryResult> => {
      let rebuilt = false;
      if (willBuild) {
        if (!existsSync(dbFile) || !meta) {
          console.error("semantic-layer search: no index found yet; building one now.");
        }
        await buildIndexWithConnection(
          conn,
          config,
          { full: opts.rebuild === true },
          embedder ? { embedder } : {},
        );
        meta = readIndexMeta(config);
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
      const queryVector = await resolveQueryVector(config, meta, mode, opts.query, { embedder });

      let hits: RawHit[];
      if (mode === "fts") {
        hits = await runFtsQuery(conn, opts, limit);
      } else if (!queryVector) {
        throw new Error(`semantic-layer search: ${mode} mode requires a query vector`);
      } else if (mode === "vector") {
        hits = await runVectorQuery(conn, opts, queryVector, limit);
      } else {
        hits = await runHybridQuery(conn, opts, queryVector, limit);
      }

      return { mode, hits, stale, rebuilt };
    };

    if (deps.connection) {
      return await runQuery(deps.connection);
    }
    return await withConnectionForConfig(config, runQuery);
  } finally {
    if (ownEmbedder && embedder?.close) {
      await embedder.close();
    }
  }
}

/**
 * A prefilter-based staleness signal, not a rebuild decision: any meta/config mismatch (via the
 * shared checks in meta.ts), a missing or unreachable stored SHA, or an actual pending vault
 * change (committed or not) counts as stale. `embedding` is checked against `embedder`'s real
 * identity when one was explicitly injected, falling back to a cheap config-derived guess
 * otherwise. Either way, a meta recording the FTS-only identity is expected whenever the
 * configured embedder is unavailable on this platform, not a sign of drift, so it's exempt.
 */
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

/**
 * Embeds the query text for vector/hybrid modes, using the same embedder identity the index was
 * built with — querying with a different embedder would produce meaningless vector distances.
 * A self-created embedder is closed before returning: it owns a native ONNX session that must
 * not leak past this call.
 */
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
        `index\`, or use --mode fts.`,
    );
  }
  const recorded = meta.embedding;

  const ownEmbedder = deps.embedder === undefined;
  const embedder = deps.embedder ?? (await createEmbedder(config.search.embedding));
  try {
    if (embedder.id !== recorded.id || embedder.dimensions !== recorded.dimensions) {
      throw new Error(
        `semantic-layer search: the index was built with embedder "${recorded.id}" but ` +
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

/**
 * The status/tags/audience prefilters as Cypher WHERE fragments over the note that owns each
 * chunk. LadybugDB 0.18.2 only supports the `EXISTS { MATCH ... }` subquery form (pattern-only
 * `EXISTS { (note)-[:HAS_TAG]->(...) }` is a parser error), and WHERE must attach to a MATCH
 * clause — it cannot directly follow a CALL...YIELD.
 */
function buildFilters(opts: SearchQueryOptions): {
  where: string;
  params: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.status) {
    clauses.push("note.status = $status");
    params.status = opts.status;
  }
  if (opts.tags?.length) {
    clauses.push(
      "EXISTS { MATCH (note)-[:HAS_TAG]->(filterTag:Tag) WHERE filterTag.name IN $tags }",
    );
    params.tags = opts.tags;
  }
  if (opts.audience?.length) {
    clauses.push(
      "EXISTS { MATCH (note)-[:HAS_AUDIENCE]->(filterAudience:Audience) WHERE filterAudience.name IN $audience }",
    );
    params.audience = opts.audience;
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const HIT_COLUMNS = `
  chunk.id AS id,
  chunk.noteId AS noteId,
  chunk.headingPath AS headingPath,
  note.title AS title,
  chunk.text AS text,
  note.status AS status
`;

async function runFtsQuery(
  conn: Connection,
  opts: SearchQueryOptions,
  limit: number,
): Promise<RawHit[]> {
  const { where, params } = buildFilters(opts);
  const rows = await queryRows(
    conn,
    `CALL QUERY_FTS_INDEX("Chunk", "${FTS_INDEX_NAME}", $term)
     YIELD node AS chunk, score
     MATCH (note:Note {id: chunk.noteId})
     ${where}
     RETURN ${HIT_COLUMNS}, score
     ORDER BY score DESC
     LIMIT $limit`,
    { ...params, term: opts.query, limit },
  );
  return rows.map((row) => toRawHit(row, Number(row.score)));
}

async function runVectorQuery(
  conn: Connection,
  opts: SearchQueryOptions,
  queryVector: number[],
  limit: number,
): Promise<RawHit[]> {
  const { where, params } = buildFilters(opts);
  const distanceFilter = `distance <= $radius${where ? ` AND ${where.slice("WHERE ".length)}` : ""}`;
  const rows = await queryRows(
    conn,
    `CALL QUERY_VECTOR_INDEX("Chunk", "${VECTOR_INDEX_NAME}", $queryVector, $k)
     YIELD node AS chunk, distance
     MATCH (note:Note {id: chunk.noteId})
     WHERE ${distanceFilter}
     RETURN ${HIT_COLUMNS}, distance
     ORDER BY distance ASC
     LIMIT $limit`,
    {
      ...params,
      queryVector,
      k: candidateLimit(limit),
      radius: VECTOR_DISTANCE_RADIUS,
      limit,
    },
  );
  // Convert cosine distance back to a similarity so every mode's score is "higher is better".
  return rows.map((row) => toRawHit(row, 1 - Number(row.distance)));
}

/**
 * Hybrid = one FTS query plus one vector query, fused with reciprocal rank fusion. LadybugDB has
 * no built-in hybrid operator, and fusing in TypeScript keeps the ranking fully inspectable. A
 * chunk that only one side found still surfaces through that side's rank alone.
 */
async function runHybridQuery(
  conn: Connection,
  opts: SearchQueryOptions,
  queryVector: number[],
  limit: number,
): Promise<RawHit[]> {
  const candidates = candidateLimit(limit);
  const ftsRows = await runFtsQuery(conn, opts, candidates);
  const vectorRows = await runVectorQuery(conn, opts, queryVector, candidates);

  const fused = new Map<string, RawHit>();
  const addRanked = (rows: RawHit[]) => {
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(row.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(row.id, { ...row, score: contribution });
      }
    });
  };
  addRanked(ftsRows);
  addRanked(vectorRows);

  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
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
