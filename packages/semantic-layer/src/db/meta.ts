import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Embedder } from "../search/embedder.js";
import type { ResolvedConfig, ResolvedWikilinkConfig } from "../types.js";
import { dbFileForConfig, openDatabase, type SqliteConnection } from "./connection.js";
import { SCHEMA_VERSION } from "./schema.js";

export type IndexEmbeddingMeta =
  | { kind: "embedder"; id: string; dimensions: number }
  | { kind: "fts-only" };

export type IndexMeta = {
  schemaVersion: number;
  vaultDir: string;
  lastIndexedSha?: string;
  lastIndexedAt: string;
  embedding: IndexEmbeddingMeta;
  chunking: { strategy: string; maxChunkChars: number };
  wikilinks: ResolvedWikilinkConfig;
  noteContentHashes: Record<string, string>;
};

const INDEX_META_KEY = "index_meta";

function validMeta(meta: unknown): meta is IndexMeta {
  const value = meta as Partial<IndexMeta>;
  return (
    typeof value?.schemaVersion === "number" &&
    typeof value.vaultDir === "string" &&
    typeof value.chunking?.strategy === "string" &&
    typeof value.chunking?.maxChunkChars === "number" &&
    (value.wikilinks?.aliasOrder === "dendron" || value.wikilinks?.aliasOrder === "obsidian") &&
    (value.embedding?.kind === "embedder" || value.embedding?.kind === "fts-only") &&
    value.noteContentHashes !== null &&
    typeof value.noteContentHashes === "object"
  );
}

export function readIndexMeta(
  config: ResolvedConfig,
  conn?: SqliteConnection,
): IndexMeta | undefined {
  const dbPath = dbFileForConfig(config);
  if (!conn && !existsSync(dbPath)) return undefined;
  const db = conn ?? openDatabase(dbPath);
  try {
    let row: { value?: string } | undefined;
    try {
      row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(INDEX_META_KEY) as
        | { value?: string }
        | undefined;
    } catch (error) {
      // A fresh, uninitialized SQLite file has no metadata table yet. Do not mask physical
      // corruption: the builder needs that exact error to quarantine/rebuild derived state.
      if (/no such table: metadata/i.test(String(error))) return undefined;
      throw error;
    }
    if (!row?.value) return undefined;
    try {
      const meta: unknown = JSON.parse(row.value);
      return validMeta(meta) ? meta : undefined;
    } catch {
      return undefined;
    }
  } finally {
    if (!conn) db.close();
  }
}

/** Must be called on the active index transaction when one exists. */
export function writeIndexMeta(meta: IndexMeta, conn: SqliteConnection): void {
  conn
    .prepare(
      "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(INDEX_META_KEY, JSON.stringify(meta));
}

export function readBooleanMetadata(conn: SqliteConnection, key: string): boolean | undefined {
  let row: { value?: string } | undefined;
  try {
    row = conn.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
  } catch (error) {
    if (/no such table: metadata/i.test(String(error))) return undefined;
    throw error;
  }
  return row ? row.value === "true" : undefined;
}

export function writeBooleanMetadata(conn: SqliteConnection, key: string, value: boolean): void {
  conn
    .prepare(
      "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value ? "true" : "false");
}

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
  if (meta.wikilinks.aliasOrder !== config.wikilinks.aliasOrder) {
    reasons.push("wikilink alias-order config changed since the index was built");
  }
  return reasons;
}

export function embeddingStalenessReason(
  meta: IndexMeta,
  expected: { id: string; dimensions: number } | undefined,
): string | undefined {
  if (meta.embedding.kind === "fts-only") {
    return expected
      ? `index was built without embeddings but "${expected.id}" is now available`
      : undefined;
  }
  if (!expected) return "index has embeddings but no embedder is available";
  return meta.embedding.id !== expected.id || meta.embedding.dimensions !== expected.dimensions
    ? `index was built with embedder "${meta.embedding.id}" (${meta.embedding.dimensions} dimensions) but "${expected.id}" (${expected.dimensions} dimensions) is configured`
    : undefined;
}

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
  return embedder
    ? { kind: "embedder", id: embedder.id, dimensions: embedder.dimensions }
    : { kind: "fts-only" };
}
