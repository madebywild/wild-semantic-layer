import { describe, expect, it, vi } from "vitest";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import type { Embedder } from "../../../../../packages/semantic-layer/src/search/embedder.js";
import {
  createResolvedConfig,
  createTempVault,
  gitCommitAll,
  initGitRepo,
  noteMarkdown,
} from "../../../../helpers.js";

// querySearch must never leak a native session: every embedder it creates itself (instead of
// receiving one through deps) has to be closed, whether it was shared with a cold-start build or
// created just to embed the query. Mock createEmbedder with a close-spied fake so the test stays
// ONNX-free.
const closeSpy = vi.fn();
const embedQuerySpy = vi.fn();

const fakeEmbedder: Embedder = {
  id: "fake:lifecycle",
  dimensions: 8,
  embedDocuments: (texts) =>
    Promise.resolve(texts.map((text) => Array.from({ length: 8 }, (_, i) => text.length + i))),
  embedQuery: (text) => {
    embedQuerySpy(text);
    return Promise.resolve(Array.from({ length: 8 }, (_, i) => text.length + i));
  },
  close: async () => {
    closeSpy();
  },
};

vi.mock(
  "../../../../../packages/semantic-layer/src/search/embedder.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../../packages/semantic-layer/src/search/embedder.js")
    >()),
    createEmbedder: vi.fn(async () => fakeEmbedder),
  }),
);

function lifecycleVault() {
  const tv = createTempVault({
    "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n\nLifecycle content.\n" }),
  });
  initGitRepo(tv.dir);
  gitCommitAll(tv.dir, "initial");
  return tv;
}

describe("querySearch embedder lifecycle", () => {
  it("closes the embedder it created for a query against an existing index", async () => {
    const tv = lifecycleVault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      // Build with the fake injected; the meta records its identity so the mocked
      // createEmbedder resolves to the same identity at query time. The build itself must NOT
      // close a deps-injected embedder...
      await buildIndex(config, {}, { embedder: fakeEmbedder });
      expect(closeSpy).not.toHaveBeenCalled();

      closeSpy.mockClear();
      embedQuerySpy.mockClear();

      // ...but a query with no deps.embedder must create AND close the embedder itself.
      const result = await querySearch(config, { query: "lifecycle", mode: "vector" });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(embedQuerySpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      tv.cleanup();
    }
  });

  it("closes the shared cold-start embedder exactly once", async () => {
    const tv = lifecycleVault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      closeSpy.mockClear();

      const result = await querySearch(config, { query: "lifecycle", mode: "hybrid" });
      expect(result.rebuilt).toBe(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      tv.cleanup();
    }
  });
});
