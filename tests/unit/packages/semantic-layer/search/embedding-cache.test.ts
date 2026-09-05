import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../../packages/semantic-layer/src/search/embedder.js";
import {
  embeddingCacheFileForConfig,
  withEmbeddingCache,
} from "../../../../../packages/semantic-layer/src/search/embedding-cache.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempDir,
  gitCommitAll,
  initGitRepo,
} from "../../../../helpers.js";

// Some cases drive real git subprocesses (worktree creation), which are slower than the unit
// project's 5s default under parallel load.
vi.setConfig({ testTimeout: 15_000 });

/** A fake embedder that records every text it was actually asked to compute. */
function createCountingEmbedder(id = "fake:8"): Embedder & { computed: string[] } {
  const inner = createFakeEmbedder(8);
  const computed: string[] = [];
  return {
    id,
    dimensions: inner.dimensions,
    computed,
    embedDocuments: (texts) => {
      computed.push(...texts);
      return inner.embedDocuments(texts);
    },
    embedQuery: (text) => inner.embedQuery(text),
  };
}

const cleanups: (() => void)[] = [];

function tempDir(): string {
  const { dir, cleanup } = createTempDir();
  cleanups.push(cleanup);
  return dir;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  delete process.env.SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE;
});

describe("embeddingCacheFileForConfig", () => {
  it("puts the cache in the shared git directory, which every worktree of the repo resolves to", () => {
    const dir = tempDir();
    initGitRepo(dir);
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault", "root.md"), "# Root\n");
    gitCommitAll(dir, "initial commit");

    const worktree = join(tempDir(), "linked");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], {
      cwd: dir,
      stdio: "ignore",
    });

    const main = embeddingCacheFileForConfig(
      createResolvedConfig({ repoRoot: dir, vaultDir: join(dir, "vault") }),
    );
    const linked = embeddingCacheFileForConfig(
      createResolvedConfig({ repoRoot: worktree, vaultDir: join(worktree, "vault") }),
    );

    expect(linked).toBe(main);
    // The shared file still lives inside the repository, never in a home or system directory.
    expect(main.startsWith(join(dir, ".git"))).toBe(true);
  });

  it("falls back to the vault's own directory outside a git repository", () => {
    const dir = tempDir();
    const vaultDir = join(dir, "vault");
    expect(embeddingCacheFileForConfig(createResolvedConfig({ repoRoot: dir, vaultDir }))).toBe(
      join(vaultDir, ".semantic-layer", "embeddings.sqlite"),
    );
  });
});

describe("withEmbeddingCache", () => {
  it("reuses stored vectors for unchanged text, which is what spares a new worktree a full rebuild", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const texts = ["alpha chunk", "beta chunk"];

    const first = createCountingEmbedder();
    const firstVectors = await withEmbeddingCache(first, cacheFile).embedDocuments(texts);
    await withEmbeddingCache(first, cacheFile).close?.();

    const second = createCountingEmbedder();
    const cached = withEmbeddingCache(second, cacheFile);
    const secondVectors = await cached.embedDocuments(texts);
    await cached.close?.();

    expect(first.computed).toEqual(texts);
    expect(second.computed).toEqual([]);
    expect(secondVectors).toEqual(firstVectors);
  });

  it("returns the vectors the index would have stored, so a cached build is not a different index", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const [fresh] = await createCountingEmbedder().embedDocuments(["alpha chunk"]);

    const cache = withEmbeddingCache(createCountingEmbedder(), cacheFile);
    const [computed] = await cache.embedDocuments(["alpha chunk"]);
    const [reused] = await cache.embedDocuments(["alpha chunk"]);
    await cache.close?.();

    // The index persists Float32 blobs, so a stored vector is the fresh vector rounded to Float32,
    // and a miss returns the same rounding as a hit.
    expect(reused).toEqual([...new Float32Array(fresh as number[])]);
    expect(computed).toEqual(reused);
  });

  it("computes only the texts it has never seen", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const first = withEmbeddingCache(createCountingEmbedder(), cacheFile);
    await first.embedDocuments(["kept chunk"]);
    await first.close?.();

    const second = createCountingEmbedder();
    const cache = withEmbeddingCache(second, cacheFile);
    const vectors = await cache.embedDocuments(["kept chunk", "edited chunk"]);
    await cache.close?.();

    expect(second.computed).toEqual(["edited chunk"]);
    expect(vectors).toHaveLength(2);
  });

  it("never serves one embedder's vectors to another, so a model change cannot leave stale vectors", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const nomic = withEmbeddingCache(createCountingEmbedder("local:nomic"), cacheFile);
    const nomicVectors = await nomic.embedDocuments(["shared chunk"]);
    await nomic.close?.();

    const other = createCountingEmbedder("local:other");
    const otherCache = withEmbeddingCache(other, cacheFile);
    const otherVectors = await otherCache.embedDocuments(["shared chunk"]);
    await otherCache.close?.();

    // The second model recomputed the text instead of inheriting the first model's vector, and
    // both entries coexist under their own keys.
    expect(other.computed).toEqual(["shared chunk"]);
    expect(otherVectors).toHaveLength(nomicVectors.length);
    const db = new DatabaseSync(cacheFile);
    const rows = db.prepare("SELECT count(*) AS count FROM embeddings").get() as { count: number };
    db.close();
    expect(rows.count).toBe(2);
  });

  it("keeps embedding when the cache file is unusable instead of failing the build", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    writeFileSync(cacheFile, "not a database");
    const embedder = createCountingEmbedder();

    const cache = withEmbeddingCache(embedder, cacheFile);
    const vectors = await cache.embedDocuments(["alpha chunk"]);
    await cache.close?.();

    expect(vectors).toHaveLength(1);
    expect(embedder.computed).toEqual(["alpha chunk"]);
  });

  it("writes nothing when the cache is switched off", async () => {
    process.env.SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE = "1";
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const embedder = createCountingEmbedder();

    expect(withEmbeddingCache(embedder, cacheFile)).toBe(embedder);
  });

  it("drops entries that no build has used for a month, so the file cannot grow without bound", async () => {
    const cacheFile = join(tempDir(), "embeddings.sqlite");
    const cache = withEmbeddingCache(createCountingEmbedder(), cacheFile);
    await cache.embedDocuments(["kept chunk"]);
    await cache.close?.();

    const stale = new DatabaseSync(cacheFile);
    const staleStamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
    stale
      .prepare("INSERT INTO embeddings(key, vector, used_at) VALUES (?, ?, ?)")
      .run("stale-key", Buffer.from(new Float32Array(8).buffer), staleStamp);
    stale.close();

    const second = withEmbeddingCache(createCountingEmbedder(), cacheFile);
    await second.embedDocuments(["kept chunk"]);
    await second.close?.();

    const db = new DatabaseSync(cacheFile);
    const keys = (db.prepare("SELECT key FROM embeddings").all() as { key: string }[]).map(
      (row) => row.key,
    );
    db.close();

    expect(keys).toHaveLength(1);
    expect(keys).not.toContain("stale-key");
  });
});
