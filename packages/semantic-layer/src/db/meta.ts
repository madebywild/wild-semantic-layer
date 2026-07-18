import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Embedder } from "../search/embedder.js";
import type { ResolvedConfig } from "../types.js";
import { SCHEMA_VERSION } from "./schema.js";

/** Discriminated union so `kind` (not the free-form `id` string) drives narrowing. */
export type IndexEmbeddingMeta =
  | { kind: "embedder"; id: string; dimensions: number }
  | { kind: "fts-only" };

export type IndexMeta = {
  schemaVersion: number;
  vaultDir: string;
  /** Informational only: the HEAD the index was built at, used for query-time staleness warnings. */
  lastIndexedSha?: string;
  lastIndexedAt: string;
  embedding: IndexEmbeddingMeta;
  chunking: {
    strategy: string;
    maxChunkChars: number;
  };
  noteContentHashes: Record<string, string>;
};

export function indexMetaPath(config: ResolvedConfig): string {
  return resolve(config.vaultDir, ".semantic-layer", "vault.lbug.meta.json");
}

export function readIndexMeta(config: ResolvedConfig): IndexMeta | undefined {
  const path = indexMetaPath(config);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const meta = JSON.parse(raw) as IndexMeta;
    // Shape-validate the fields the callers dereference: a structurally corrupt meta (valid JSON,
    // wrong shape — e.g. hand-edited) must read as "no meta" so the index self-heals with a full
    // rebuild instead of crashing on a raw TypeError.
    if (
      typeof meta.schemaVersion !== "number" ||
      typeof meta.vaultDir !== "string" ||
      typeof meta.chunking?.strategy !== "string" ||
      typeof meta.chunking?.maxChunkChars !== "number" ||
      typeof meta.embedding?.kind !== "string" ||
      typeof meta.noteContentHashes !== "object"
    ) {
      return undefined;
    }
    return meta;
  } catch {
    return undefined;
  }
}

export function writeIndexMeta(config: ResolvedConfig, meta: IndexMeta): void {
  const path = indexMetaPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf8");
  renameSync(tmpPath, path);
}

/**
 * Config-level drift between the live config and the built index: schema layout, vault location,
 * and chunking parameters. Shared by the build-time rebuild decision, the query-time staleness
 * warning, and the graph-command warning so the three can never drift apart.
 */
export function configStalenessReasons(config: ResolvedConfig, meta: IndexMeta): string[] {
  const reasons: string[] = [];
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    reasons.push(
      `index schema version ${meta.schemaVersion} does not match expected ${SCHEMA_VERSION}`,
    );
  }
  if (resolve(config.vaultDir) !== resolve(meta.vaultDir)) {
    reasons.push("index was built for a different vault directory");
  }
  if (
    meta.chunking.strategy !== config.search.chunking.strategy ||
    meta.chunking.maxChunkChars !== config.search.chunking.maxChunkChars
  ) {
    reasons.push("chunking config changed since the index was built");
  }
  return reasons;
}

/**
 * Whether the meta's recorded embedding identity mismatches the expected one. `expected` is
 * undefined when no embedder is available on this platform; a meta recording "fts-only" is only
 * stale when an embedder IS available (the index could be upgraded to vectors).
 */
export function embeddingStalenessReason(
  meta: IndexMeta,
  expected: { id: string; dimensions: number } | undefined,
): string | undefined {
  const recorded = meta.embedding;
  if (recorded.kind === "fts-only") {
    return expected
      ? `index was built without embeddings but "${expected.id}" is now available`
      : undefined;
  }
  if (!expected) return "index has embeddings but no embedder is available";
  if (recorded.id !== expected.id || recorded.dimensions !== expected.dimensions) {
    return (
      `index was built with embedder "${recorded.id}" (${recorded.dimensions} dimensions) ` +
      `but "${expected.id}" (${expected.dimensions} dimensions) is configured`
    );
  }
  return undefined;
}

/**
 * The build-time rebuild decision: any config drift or embedding-identity mismatch forces a full
 * rebuild. Note content is NOT part of this check — incremental rebuilds reconcile content hashes
 * against the live vault directly, so git state and SHAs never decide index correctness.
 */
export function buildStalenessReasons(
  config: ResolvedConfig,
  meta: IndexMeta,
  embedder?: Embedder,
): string[] {
  const reasons = configStalenessReasons(config, meta);
  const embeddingReason = embeddingStalenessReason(
    meta,
    embedder ? { id: embedder.id, dimensions: embedder.dimensions } : undefined,
  );
  if (embeddingReason) reasons.push(embeddingReason);
  return reasons;
}

export function isIndexStale(
  config: ResolvedConfig,
  meta: IndexMeta,
  embedder?: Embedder,
): boolean {
  return buildStalenessReasons(config, meta, embedder).length > 0;
}

export function embedderMeta(embedder?: Embedder): IndexEmbeddingMeta {
  if (!embedder) return { kind: "fts-only" };
  return { kind: "embedder", id: embedder.id, dimensions: embedder.dimensions };
}
