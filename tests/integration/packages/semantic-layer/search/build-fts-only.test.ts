import { search as searchIndex } from "@orama/orama";
import { describe, expect, it, vi } from "vitest";

// Simulates fastembed being unavailable (e.g. no musl build on Alpine) without needing a real
// unsupported platform: mocks only `createEmbedder`, keeping everything else (including the real
// `FastEmbedUnavailableError` class) so build.ts's `instanceof` check still narrows correctly.
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
const { searchBuildResolved } = await import(
  "../../../../../packages/semantic-layer/src/search/build.js"
);
const { loadIndex } = await import(
  "../../../../../packages/semantic-layer/src/search/persistence.js"
);
const { readManifest } = await import(
  "../../../../../packages/semantic-layer/src/search/manifest.js"
);
const { createTempVault, noteMarkdown } = await import("../../../../helpers.js");

describe("searchBuildResolved — fastembed unavailable", () => {
  it("degrades to an FTS-only index instead of failing the whole build", async () => {
    const tv = createTempVault({
      "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const config = loadConfig({ cwd: tv.dir });
      const result = await searchBuildResolved(config);

      expect(result.mode).toBe("full");
      expect(result.ftsOnly).toBe(true);
      expect(result.noteCount).toBe(2);

      const manifest = readManifest(result.manifestFile);
      expect(manifest?.embedding).toEqual({ id: "fts-only", dimensions: 1 });

      const index = await loadIndex(result.indexFile);
      if (!index) throw new Error("expected a persisted index");
      const hits = (await searchIndex(index, { term: "widgets" })).hits;
      expect(hits.map((hit) => hit.document.noteId)).toContain("alpha");
      expect(hits[0]?.document.embedding).toBeFalsy();

      const vectorResult = await searchIndex(index, {
        mode: "vector",
        term: "widgets",
        vector: { value: [0], property: "embedding" },
      });
      expect(vectorResult.hits).toEqual([]);
    } finally {
      tv.cleanup();
    }
  });
});
