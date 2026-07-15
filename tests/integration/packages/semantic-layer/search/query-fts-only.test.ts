import { describe, expect, it, vi } from "vitest";

// Simulates fastembed being unavailable, the same way build-fts-only.test.ts does — mocks only
// `createEmbedder`, keeping everything else (including the real `FastEmbedUnavailableError`
// class) so both build.ts's and query.ts's `instanceof` checks still narrow correctly.
vi.mock("../../../../../packages/semantic-layer/src/search/embedder.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../../packages/semantic-layer/src/search/embedder.js")
    >();
  return {
    ...actual,
    createEmbedder: async () => {
      throw new actual.FastEmbedUnavailableError(new Error("simulated: no musl build"));
    },
  };
});

const { loadConfig } = await import("../../../../../packages/semantic-layer/src/config.js");
const { searchQueryResolved } = await import(
  "../../../../../packages/semantic-layer/src/search/query.js"
);
const { createTempVault, noteMarkdown } = await import("../../../../helpers.js");

describe("searchQueryResolved — fastembed unavailable on cold start", () => {
  it("builds a usable FTS-only index instead of throwing a raw platform error", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const config = loadConfig({ cwd: tv.dir });

      // No --mode flag: this is the CLI's actual default (search.defaultMode: "hybrid"), which
      // needs a vector. Vector/hybrid modes still correctly fail against an FTS-only index — that
      // part is unavoidable — but the fix is that the build must succeed first and fail with the
      // clear, mode-specific message, not the raw FastEmbedUnavailableError, and it must leave a
      // usable FTS-only index behind rather than nothing.
      await expect(searchQueryResolved(config, { query: "widgets" })).rejects.toThrow(/FTS-only/);

      const ftsResult = await searchQueryResolved(config, { query: "widgets", mode: "fts" });
      expect(ftsResult.rebuilt).toBe(false);
      expect(ftsResult.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      tv.cleanup();
    }
  });
});
