import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { persistToFile, restoreFromFile } from "@orama/plugin-data-persistence/server";
import type { SearchIndex } from "./schema.js";

const PERSISTENCE_FORMAT = "binary";

/** Loads a persisted search index from disk, or `undefined` if no index file exists yet. */
export async function loadIndex(indexFile: string): Promise<SearchIndex | undefined> {
  if (!existsSync(indexFile)) return undefined;
  return restoreFromFile<SearchIndex>(PERSISTENCE_FORMAT, indexFile);
}

/**
 * Persists a search index atomically: writes to `<file>.tmp`, then renames it into place —
 * mirroring `refinement-store.ts`'s write-then-rename convention so a crash mid-write can never
 * leave a truncated index behind.
 */
export async function saveIndexAtomic(index: SearchIndex, indexFile: string): Promise<void> {
  mkdirSync(dirname(indexFile), { recursive: true });
  const tmpFile = `${indexFile}.tmp`;
  await persistToFile(index, PERSISTENCE_FORMAT, tmpFile);
  renameSync(tmpFile, indexFile);
}
