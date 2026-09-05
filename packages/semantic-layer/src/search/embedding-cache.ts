import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../types.js";
import type { Embedder } from "./embedder.js";
import { getGitCommonDir } from "./git-diff.js";

/**
 * Bumped only when the stored value stops meaning what an older build wrote, which the key
 * material below cannot express on its own. Every input that the vector depends on is already in
 * the key: the embedder identity (model), the dimensions, and the exact text.
 */
const CACHE_KEY_VERSION = "1";

/** Entries untouched for this long are dropped after a build, which bounds the file. */
const PRUNE_AFTER_DAYS = 30;

/** `key IN (…)` batch size, well under SQLite's bound-parameter limit. */
const READ_BATCH_SIZE = 500;

/**
 * A shared, content-addressed store of document vectors, so re-embedding unchanged text is a
 * SQLite read instead of a model forward pass.
 *
 * The store lives in the repository's common git directory, thus every linked worktree of one
 * repository shares it: a new worktree indexes the same notes at the same commit and hits the
 * cache for nearly every chunk, instead of paying a full rebuild. Nothing is written outside the
 * repository, and nothing is shared between repositories.
 *
 * Correctness comes from the key, not from invalidation: a key covers the embedder id, the
 * dimensions, and the text itself, so changed text, changed chunking, or a changed model all miss
 * and recompute. A hit therefore returns the vector that a fresh call would have produced.
 */
export function embeddingCacheFileForConfig(config: ResolvedConfig): string {
  const gitCommonDir = getGitCommonDir(config.repoRoot);
  return gitCommonDir
    ? join(gitCommonDir, "semantic-layer", "embeddings.sqlite")
    : resolve(config.vaultDir, ".semantic-layer", "embeddings.sqlite");
}

/**
 * Wraps `embedder` so `embedDocuments` reads known vectors from `cacheFile` and only computes the
 * rest. Queries stay uncached: they are one text per search, and storing them would put user
 * search terms on disk for no measurable gain.
 *
 * The cache is an optimization, never a dependency: any store failure degrades to the plain
 * embedder for the rest of the process.
 */
export function withEmbeddingCache(embedder: Embedder, cacheFile: string): Embedder {
  if (process.env.SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE) return embedder;
  const store = openStore(cacheFile);
  if (!store) return embedder;

  return {
    id: embedder.id,
    dimensions: embedder.dimensions,
    embedQuery: (text) => embedder.embedQuery(text),
    embedDocuments: async (texts) => {
      const keys = texts.map((text) => cacheKey(embedder, text));
      const cached = store.read(keys, embedder.dimensions);
      const hitKeys = [...cached.keys()];
      const missingIndexes = keys.flatMap((key, index) => (cached.has(key) ? [] : [index]));
      const computed = missingIndexes.length
        ? await embedder.embedDocuments(missingIndexes.map((index) => texts[index] as string))
        : [];
      if (computed.length !== missingIndexes.length) {
        throw new Error(
          `embedder returned ${computed.length} vectors for ${missingIndexes.length} texts`,
        );
      }
      // Round a fresh vector to what the store (and the index) holds, so one build's output does
      // not depend on whether a vector came from the cache or from the model.
      const added: [string, number[]][] = missingIndexes.map((index, position) => [
        keys[index] as string,
        [...new Float32Array(computed[position] as number[])],
      ]);
      for (const [key, vector] of added) cached.set(key, vector);
      store.write(added, hitKeys);
      return keys.map((key) => cached.get(key) as number[]);
    },
    close: async () => {
      store.close();
      await embedder.close?.();
    },
  };
}

function cacheKey(embedder: Embedder, text: string): string {
  return createHash("sha256")
    .update(CACHE_KEY_VERSION)
    .update("\0")
    .update(embedder.id)
    .update("\0")
    .update(String(embedder.dimensions))
    .update("\0")
    .update(text)
    .digest("hex");
}

type EmbeddingStore = {
  read(keys: string[], dimensions: number): Map<string, number[]>;
  write(added: [string, number[]][], hitKeys: string[]): void;
  close(): void;
};

/**
 * Opens (or creates) the store. A cache that cannot be opened, including a corrupt file, is
 * removed once and reopened; a second failure disables caching for this process rather than
 * failing the build.
 */
function openStore(cacheFile: string): EmbeddingStore | undefined {
  let db = openDatabase(cacheFile);
  if (!db) {
    removeStore(cacheFile);
    db = openDatabase(cacheFile);
  }
  if (!db) return undefined;
  const handle = db;
  let usable = true;
  const disable = (error: unknown) => {
    usable = false;
    console.error(
      `semantic-layer: embedding cache disabled for this run (${cacheFile}): ${String(error)}`,
    );
  };

  return {
    read(keys, dimensions) {
      const vectors = new Map<string, number[]>();
      if (!usable) return vectors;
      try {
        for (let start = 0; start < keys.length; start += READ_BATCH_SIZE) {
          const batch = keys.slice(start, start + READ_BATCH_SIZE);
          const rows = handle
            .prepare(
              `SELECT key, vector FROM embeddings WHERE key IN (${batch.map(() => "?").join(",")})`,
            )
            .all(...batch) as { key: string; vector: Uint8Array }[];
          for (const row of rows) {
            const vector = toVector(row.vector);
            // Length is already pinned by the key; the guard keeps a hand-edited or truncated
            // row from reaching the index as a short vector.
            if (vector.length === dimensions) vectors.set(row.key, vector);
          }
        }
      } catch (error) {
        disable(error);
        return new Map();
      }
      return vectors;
    },
    write(entries, usedKeys) {
      if (!usable) return;
      try {
        handle.exec("BEGIN IMMEDIATE");
        try {
          const insert = handle.prepare(
            "INSERT INTO embeddings(key, vector, used_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET used_at = excluded.used_at",
          );
          const now = Date.now();
          for (const [key, vector] of entries) {
            insert.run(key, Buffer.from(new Float32Array(vector).buffer), now);
          }
          // Refresh every key this build used, not only the new ones, so a vault whose notes
          // never change does not expire out of the cache and pay a full rebuild.
          const touch = handle.prepare("UPDATE embeddings SET used_at = ? WHERE key = ?");
          for (const key of usedKeys) touch.run(now, key);
          handle.exec("COMMIT");
        } catch (error) {
          handle.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        disable(error);
      }
    },
    close() {
      try {
        if (usable) {
          handle
            .prepare("DELETE FROM embeddings WHERE used_at < ?")
            .run(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000);
        }
        handle.close();
      } catch {
        // A cache that fails to prune or close costs nothing: the process is done with it.
      }
    },
  };
}

function openDatabase(cacheFile: string): DatabaseSync | undefined {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const db = new DatabaseSync(cacheFile, { timeout: 5_000 });
    // Concurrent worktrees write the same file; WAL plus the busy timeout above lets them.
    // `synchronous=NORMAL` is enough for a cache whose worst loss is one recomputation.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB NOT NULL, used_at INTEGER NOT NULL)",
    );
    return db;
  } catch {
    return undefined;
  }
}

function removeStore(cacheFile: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${cacheFile}${suffix}`, { force: true });
    } catch {
      // Leave an undeletable file alone; the caller degrades to no cache.
    }
  }
}

/** Stored exactly as the index stores vectors, so a hit is byte-identical to a fresh build. */
function toVector(blob: Uint8Array): number[] {
  // `slice` copies into a fresh, 4-byte-aligned buffer: a SQLite blob view is not guaranteed to
  // start at an offset that `Float32Array` accepts.
  const aligned = blob.slice(0, blob.byteLength - (blob.byteLength % 4));
  return [...new Float32Array(aligned.buffer)];
}
