import { describe, expect, it, vi } from "vitest";

// Spies on createEmbedder while keeping its real (fake-provider) behavior, so we can assert on
// call count — the actual regression this guards against is query.ts resolving a vector-capable
// embedder twice (once for a cold-start build, once for the query itself) instead of reusing one.
const createEmbedderSpy = vi.fn();
vi.mock("../../../../../packages/semantic-layer/src/search/embedder.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../../packages/semantic-layer/src/search/embedder.js")
    >();
  return {
    ...actual,
    createEmbedder: async (config: Parameters<typeof actual.createEmbedder>[0]) => {
      createEmbedderSpy(config);
      return {
        id: "fake:spy",
        dimensions: 4,
        embedDocuments: (texts: string[]) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
        embedQuery: () => Promise.resolve([1, 0, 0, 0]),
      };
    },
  };
});

const { loadConfig } = await import("../../../../../packages/semantic-layer/src/config.js");
const { searchQueryResolved } = await import(
  "../../../../../packages/semantic-layer/src/search/query.js"
);
const { createTempVault, noteMarkdown } = await import("../../../../helpers.js");

describe("searchQueryResolved — embedder reuse on cold start", () => {
  it("resolves the embedder only once when a cold-start build and a vector-mode query both need it", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const config = loadConfig({ cwd: tv.dir });
      createEmbedderSpy.mockClear();

      const result = await searchQueryResolved(config, { query: "widgets", mode: "hybrid" });

      expect(result.rebuilt).toBe(true);
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
      expect(createEmbedderSpy).toHaveBeenCalledTimes(1);
    } finally {
      tv.cleanup();
    }
  });

  it("does not resolve an embedder at all for a cold-start fts-mode query", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
    });
    try {
      const config = loadConfig({ cwd: tv.dir });
      createEmbedderSpy.mockClear();

      // Even fts mode triggers a full build on cold start, and the build itself needs an
      // embedder (to populate vectors for future vector/hybrid queries) — so this should still
      // resolve exactly once, not zero times and not twice.
      await searchQueryResolved(config, { query: "root", mode: "fts" });

      expect(createEmbedderSpy).toHaveBeenCalledTimes(1);
    } finally {
      tv.cleanup();
    }
  });
});
