import { join } from "node:path";
import type { SearchParams, WhereCondition } from "@orama/orama";
import { search as searchIndex } from "@orama/orama";
import { type LoadConfigOptions, loadConfig } from "../config.js";
import type { ResolvedConfig, SearchMode } from "../types.js";
import { FTS_ONLY_EMBEDDING_ID, searchBuildResolved, vaultDirRelative } from "./build.js";
import {
  createEmbedder,
  describeConfiguredEmbedder,
  type Embedder,
  FastEmbedUnavailableError,
} from "./embedder.js";
import { candidateNoteIdsSinceSha, getHeadSha, isAncestorOfHead } from "./git-diff.js";
import { readManifest, type SearchIndexManifest } from "./manifest.js";
import { loadIndex } from "./persistence.js";
import {
  SEARCH_SCHEMA_VERSION,
  type SearchDocument,
  type SearchIndex,
  type SearchSchema,
} from "./schema.js";

export type SearchQueryOptions = {
  query: string;
  mode?: SearchMode;
  limit?: number;
  status?: string;
  tags?: string[];
  audience?: string[];
  /** Runs an incremental build before querying, instead of just warning if the index looks stale. */
  rebuild?: boolean;
};

export type SearchQueryHit = {
  id: string;
  noteId: string;
  headingPath: string;
  title: string;
  text: string;
  status: string;
  score: number;
};

export type SearchQueryResult = {
  mode: SearchMode;
  hits: SearchQueryHit[];
  /** True if the index looked out of date and was NOT rebuilt (a non-fatal warning was printed). */
  stale: boolean;
  /** True if a build ran first: a cold start (no index yet) or an explicit `--rebuild`. */
  rebuilt: boolean;
};

export type SearchQueryDeps = { embedder?: Embedder };

/** Loads config from disk/CLI options, then runs a search query. */
export function runSearchQuery(
  options: LoadConfigOptions & SearchQueryOptions,
): Promise<SearchQueryResult> {
  return searchQueryResolved(loadConfig(options), options);
}

/**
 * Runs a search query for an already-resolved config. `deps.embedder` is the dependency-injection
 * seam that keeps tests network- and ONNX-free.
 */
export async function searchQueryResolved(
  config: ResolvedConfig,
  opts: SearchQueryOptions,
  deps: SearchQueryDeps = {},
): Promise<SearchQueryResult> {
  if (!config.search.enabled) {
    throw new Error("semantic-layer search: search is disabled (search.enabled: false)");
  }
  const indexFile = join(config.vaultDir, config.search.indexFile);
  const manifestFile = join(config.vaultDir, config.search.manifestFile);
  const mode = opts.mode ?? config.search.defaultMode;

  let index = await loadIndex(indexFile);
  let manifest = readManifest(manifestFile);
  let rebuilt = false;
  const willBuild = !index || !manifest || opts.rebuild;

  // If this query needs a vector AND a build is about to run, resolve the embedder once here and
  // reuse it for both — otherwise the build step and the query-embedding step would each load
  // their own native ONNX session, doubling model-load latency and memory for no benefit.
  let embedder = deps.embedder;
  if (mode !== "fts" && willBuild && !embedder) {
    try {
      embedder = await createEmbedder(config.search.embedding);
    } catch (error) {
      // Leave embedder undefined and let searchBuildResolved's own resolveEmbedder hit (and
      // gracefully degrade to FTS-only from) this same unavailability below, instead of failing
      // the whole query over a platform limitation search-index already knows how to handle.
      if (!(error instanceof FastEmbedUnavailableError)) throw error;
    }
  }

  if (willBuild) {
    if (!index || !manifest) {
      console.error("semantic-layer search: no index found yet; building one now.");
    }
    await searchBuildResolved(config, {}, embedder ? { embedder } : deps);
    index = await loadIndex(indexFile);
    manifest = readManifest(manifestFile);
    rebuilt = true;
  }
  if (!index || !manifest) {
    throw new Error("semantic-layer search: failed to build a search index");
  }

  const stale = !rebuilt && isIndexStale(config, manifest, embedder);
  if (stale) {
    console.error(
      "semantic-layer search: the vault has changed since the index was last built; results " +
        "may be stale. Run `semantic-layer search-index` or pass --rebuild to refresh.",
    );
  }

  const limit = opts.limit ?? config.search.defaultLimit;
  const where = buildWhere(opts);
  const queryVector = await resolveQueryVector(config, manifest, mode, opts.query, { embedder });
  const params = buildSearchParams(mode, opts.query, limit, where, queryVector);

  const results = await searchIndex(index, params);
  return { mode, hits: results.hits.map(toHit), stale, rebuilt };
}

/**
 * A prefilter-based staleness signal, not a rebuild decision: any manifest/config mismatch, a
 * missing or unreachable stored SHA, or an actual pending vault change (committed or not) counts
 * as stale. Mirrors `build.ts`'s fallback conditions, but only to decide whether to warn.
 *
 * Compares against the *live* config, not the manifest's own recorded values — comparing a
 * manifest field against itself would always match and silently never detect drift. `embedding`
 * is checked against `embedder`'s real identity when one was explicitly injected (a supported part
 * of the public API, not just a test seam — there's no config-derived guess that could match a
 * caller-supplied embedder), falling back to a cheap config-derived guess otherwise. Either way, a
 * manifest recording the FTS-only placeholder identity is expected whenever the configured
 * embedder is unavailable on this platform, not a sign of drift, so it's exempt from this check.
 */
function isIndexStale(
  config: ResolvedConfig,
  manifest: SearchIndexManifest,
  embedder: Embedder | undefined,
): boolean {
  if (manifest.schemaVersion !== SEARCH_SCHEMA_VERSION) return true;
  if (manifest.vaultDirRelative !== vaultDirRelative(config)) return true;
  if (
    manifest.chunking.strategy !== config.search.chunking.strategy ||
    manifest.chunking.maxChunkChars !== config.search.chunking.maxChunkChars
  ) {
    return true;
  }
  if (manifest.embedding.id !== FTS_ONLY_EMBEDDING_ID) {
    const expected = embedder
      ? { id: embedder.id, dimensions: embedder.dimensions }
      : describeConfiguredEmbedder(config.search.embedding);
    if (
      expected.id !== manifest.embedding.id ||
      expected.dimensions !== manifest.embedding.dimensions
    ) {
      return true;
    }
  }

  if (!manifest.lastIndexedSha) return false;
  if (!getHeadSha(config.repoRoot)) return true;
  if (!isAncestorOfHead(config.repoRoot, manifest.lastIndexedSha)) return true;
  return (
    candidateNoteIdsSinceSha(config.repoRoot, config.vaultDir, manifest.lastIndexedSha).length > 0
  );
}

/**
 * Embeds the query text for vector/hybrid modes, using the same embedder identity the index was
 * built with — querying with a different embedder would produce meaningless vector distances.
 */
async function resolveQueryVector(
  config: ResolvedConfig,
  manifest: SearchIndexManifest,
  mode: SearchMode,
  query: string,
  deps: SearchQueryDeps,
): Promise<number[] | undefined> {
  if (mode === "fts") return undefined;
  if (manifest.embedding.id === FTS_ONLY_EMBEDDING_ID) {
    throw new Error(
      `semantic-layer search: the index is FTS-only (no embedder was available when it was ` +
        `built); --mode ${mode} is unavailable. Fix the embedder and re-run search-index, or use ` +
        "--mode fts.",
    );
  }

  const embedder = deps.embedder ?? (await createEmbedder(config.search.embedding));
  if (embedder.id !== manifest.embedding.id) {
    throw new Error(
      `semantic-layer search: the index was built with embedder "${manifest.embedding.id}" but ` +
        `the active config resolves to "${embedder.id}". Run search-index to rebuild with the ` +
        "current embedder before using --mode vector or hybrid.",
    );
  }
  return embedder.embedQuery(query);
}

function buildWhere(opts: SearchQueryOptions): Partial<WhereCondition<SearchSchema>> | undefined {
  // Built loosely and cast once at the end: `WhereCondition` is a union with the `and`/`or`/`not`
  // combinators, so `keyof` of the union (what a strongly-typed incremental build would need) is
  // the intersection of their keys — effectively empty — even though a plain field-keyed object is
  // exactly what we're constructing here.
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = { eq: opts.status };
  if (opts.tags?.length) where.tags = { containsAny: opts.tags };
  if (opts.audience?.length) where.audience = { containsAny: opts.audience };
  return Object.keys(where).length > 0
    ? (where as Partial<WhereCondition<SearchSchema>>)
    : undefined;
}

/**
 * Orama's own default similarity threshold (0.8) assumes near-duplicate-level cosine similarity.
 * Real sentence-embedding models like BGE-small routinely score genuinely relevant matches around
 * 0.6–0.75, so the stricter default silently returns zero results for real vaults; verified against
 * fastembed's actual output during this feature's implementation, not a guessed constant.
 */
const DEFAULT_VECTOR_SIMILARITY = 0.4;

function buildSearchParams(
  mode: SearchMode,
  query: string,
  limit: number,
  where: Partial<WhereCondition<SearchSchema>> | undefined,
  queryVector: number[] | undefined,
): SearchParams<SearchIndex> {
  if (mode === "fts") {
    return { mode: "fulltext", term: query, limit, where };
  }
  if (!queryVector) throw new Error(`semantic-layer search: ${mode} mode requires a query vector`);
  if (mode === "vector") {
    return {
      mode: "vector",
      vector: { value: queryVector, property: "embedding" },
      similarity: DEFAULT_VECTOR_SIMILARITY,
      limit,
      where,
    };
  }
  return {
    mode: "hybrid",
    term: query,
    vector: { value: queryVector, property: "embedding" },
    similarity: DEFAULT_VECTOR_SIMILARITY,
    limit,
    where,
  };
}

/** `hit.document` is cast to our own `SearchDocument`: every document in this index was inserted by `build.ts` in that exact shape. */
function toHit(hit: { id: string; score: number; document: unknown }): SearchQueryHit {
  const document = hit.document as SearchDocument;
  return {
    id: hit.id,
    noteId: document.noteId,
    headingPath: document.headingPath,
    title: document.title,
    text: document.text,
    status: document.status,
    score: hit.score,
  };
}
