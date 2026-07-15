import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SearchChunkingStrategy } from "../types.js";
import { SEARCH_SCHEMA_VERSION } from "./schema.js";

/**
 * Sidecar state for a search index: the last-indexed git SHA and per-note content hashes that
 * make incremental rebuilds possible, plus enough about how the index was built to detect a
 * config change that requires a full rebuild. Lives next to the index file, not inside it, so
 * staleness can be checked without deserializing a potentially large Orama blob.
 */
export type SearchIndexManifest = {
  schemaVersion: number;
  vaultDirRelative: string;
  lastIndexedSha?: string;
  lastIndexedAt: string;
  embedding: { id: string; dimensions: number };
  chunking: { strategy: SearchChunkingStrategy; maxChunkChars: number };
  noteCount: number;
  chunkCount: number;
  noteContentHashes: Record<string, string>;
};

/** The parts of the current build configuration a manifest must match to stay incrementally usable. */
export type ManifestCompatibilityInput = {
  vaultDirRelative: string;
  embeddingId: string;
  embeddingDimensions: number;
  chunking: { strategy: SearchChunkingStrategy; maxChunkChars: number };
};

/** Reads and validates the manifest at `manifestFile`, or `undefined` if missing or unreadable. */
export function readManifest(manifestFile: string): SearchIndexManifest | undefined {
  if (!existsSync(manifestFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
    return isSearchIndexManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the manifest atomically: write to `<file>.tmp`, then rename it into place. */
export function writeManifestAtomic(manifestFile: string, manifest: SearchIndexManifest): void {
  mkdirSync(dirname(manifestFile), { recursive: true });
  const tmpFile = `${manifestFile}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmpFile, manifestFile);
}

/**
 * Whether an existing manifest can be trusted for an incremental rebuild against the current
 * configuration. Doesn't check git ancestry — the caller combines this with `isAncestorOfHead`
 * (see `git-diff.ts`) to decide between an incremental and a full rebuild.
 */
export function isManifestCompatible(
  manifest: SearchIndexManifest,
  current: ManifestCompatibilityInput,
): boolean {
  return (
    manifest.schemaVersion === SEARCH_SCHEMA_VERSION &&
    manifest.vaultDirRelative === current.vaultDirRelative &&
    manifest.embedding.id === current.embeddingId &&
    manifest.embedding.dimensions === current.embeddingDimensions &&
    manifest.chunking.strategy === current.chunking.strategy &&
    manifest.chunking.maxChunkChars === current.chunking.maxChunkChars
  );
}

function isSearchIndexManifest(value: unknown): value is SearchIndexManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.vaultDirRelative === "string" &&
    typeof candidate.lastIndexedAt === "string" &&
    (candidate.lastIndexedSha === undefined || typeof candidate.lastIndexedSha === "string") &&
    isEmbeddingSummary(candidate.embedding) &&
    isChunkingSummary(candidate.chunking) &&
    typeof candidate.noteCount === "number" &&
    typeof candidate.chunkCount === "number" &&
    isStringRecord(candidate.noteContentHashes)
  );
}

function isEmbeddingSummary(value: unknown): value is SearchIndexManifest["embedding"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.dimensions === "number";
}

function isChunkingSummary(value: unknown): value is SearchIndexManifest["chunking"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.strategy === "whole-note" || candidate.strategy === "heading") &&
    typeof candidate.maxChunkChars === "number"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
