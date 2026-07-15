import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../../../packages/semantic-layer/src/config.js";
import { searchBuildResolved } from "../../../../../packages/semantic-layer/src/search/build.js";
import { searchQueryResolved } from "../../../../../packages/semantic-layer/src/search/query.js";
import type { ResolvedConfig } from "../../../../../packages/semantic-layer/src/types.js";
import {
  createFakeEmbedder,
  createTempVault,
  gitCommitAll,
  initGitRepo,
  noteMarkdown,
} from "../../../../helpers.js";

function setupVault(files: Record<string, string>) {
  const tv = createTempVault({
    "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
    ...files,
  });
  const config = loadConfig({ cwd: tv.dir });
  return { tv, config };
}

describe("searchQueryResolved — cold start", () => {
  it("builds an index automatically when none exists yet, then queries it", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const result = await searchQueryResolved(
        config,
        { query: "widgets" },
        { embedder: createFakeEmbedder() },
      );
      expect(result.rebuilt).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      tv.cleanup();
    }
  });

  it("refuses to query when search.enabled is false", async () => {
    const { tv, config } = setupVault({});
    try {
      const disabledConfig: ResolvedConfig = {
        ...config,
        search: { ...config.search, enabled: false },
      };
      await expect(
        searchQueryResolved(
          disabledConfig,
          { query: "anything" },
          { embedder: createFakeEmbedder() },
        ),
      ).rejects.toThrow(/search is disabled/);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchQueryResolved — modes", () => {
  it("fts mode matches on text content", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
      "vault/beta.md": noteMarkdown({ id: "beta", body: "## Section\n\nGadgets galore.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts" },
        { embedder },
      );
      expect(result.mode).toBe("fts");
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
      expect(result.hits.map((hit) => hit.noteId)).not.toContain("beta");
    } finally {
      tv.cleanup();
    }
  });

  it("vector mode ranks the chunk with the identical text highest", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({
        id: "alpha",
        body: "## Section\n\nA very specific phrase.\n",
      }),
      "vault/beta.md": noteMarkdown({
        id: "beta",
        body: "## Section\n\nSomething else entirely.\n",
      }),
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "Section\n\nA very specific phrase.", mode: "vector" },
        { embedder },
      );
      expect(result.mode).toBe("vector");
      expect(result.hits[0]?.noteId).toBe("alpha");
    } finally {
      tv.cleanup();
    }
  });

  it("uses a permissive similarity threshold so a real-world-scale match still surfaces", async () => {
    const { tv, config } = setupVault({
      "vault/target.md": noteMarkdown({ id: "target", body: "TARGET_MARKER content.\n" }),
    });
    try {
      // A controlled embedder: the target note's vector and the query vector have an exact
      // cosine similarity of 0.5 (query = [0.5, √3/2], target = [1, 0]) — above this package's
      // 0.4 default, but below Orama's own out-of-the-box default of 0.8. Every other chunk maps
      // to [0, -1] (cosine -0.866 against the query), so it can only surface via this threshold.
      const embedder = {
        id: "fake:controlled",
        dimensions: 2,
        embedDocuments: async (texts: string[]) =>
          texts.map((text) => (text.includes("TARGET_MARKER") ? [1, 0] : [0, -1])),
        embedQuery: async () => [0.5, Math.sqrt(3) / 2],
      };
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "anything", mode: "vector" },
        { embedder },
      );
      expect(result.hits.map((hit) => hit.noteId)).toContain("target");
    } finally {
      tv.cleanup();
    }
  });

  it("hybrid mode combines fts and vector signals without error", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "widgets", mode: "hybrid" },
        { embedder },
      );
      expect(result.mode).toBe("hybrid");
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      tv.cleanup();
    }
  });

  it("defaults to the config's defaultMode and defaultLimit when not specified", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(config, { query: "widgets" }, { embedder });
      expect(result.mode).toBe(config.search.defaultMode);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchQueryResolved — filters", () => {
  it("filters by status, tags, and audience", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": `---
id: alpha
title: Alpha
desc: Alpha note.
status: deprecated
owner: tester@example.com
last_verified: 2026-05-13
ttl_days: 365
tags: [widgets]
audience: [eng]
---

# Alpha

Widgets content.
`,
      "vault/beta.md": `---
id: beta
title: Beta
desc: Beta note.
status: active
owner: tester@example.com
last_verified: 2026-05-13
ttl_days: 365
tags: [gadgets]
audience: [agents]
---

# Beta

Widgets content too.
`,
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const byStatus = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts", status: "active" },
        { embedder },
      );
      expect(byStatus.hits.map((hit) => hit.noteId)).toEqual(["beta"]);

      const byTag = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts", tags: ["widgets"] },
        { embedder },
      );
      expect(byTag.hits.map((hit) => hit.noteId)).toEqual(["alpha"]);

      const byAudience = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts", audience: ["agents"] },
        { embedder },
      );
      expect(byAudience.hits.map((hit) => hit.noteId)).toEqual(["beta"]);
    } finally {
      tv.cleanup();
    }
  });

  it("respects an explicit limit", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Widgets one.\n" }),
      "vault/beta.md": noteMarkdown({ id: "beta", body: "Widgets two.\n" }),
      "vault/gamma.md": noteMarkdown({ id: "gamma", body: "Widgets three.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts", limit: 1 },
        { embedder },
      );
      expect(result.hits).toHaveLength(1);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchQueryResolved — staleness and rebuild", () => {
  it("warns and still searches when the index is stale", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha original.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMarkdown({ id: "alpha", body: "Alpha changed.\n" }),
      );
      gitCommitAll(tv.dir, "edit alpha");

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await searchQueryResolved(
        config,
        { query: "original", mode: "fts" },
        { embedder },
      );
      expect(result.stale).toBe(true);
      expect(result.rebuilt).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("results"));
      errorSpy.mockRestore();
    } finally {
      tv.cleanup();
    }
  });

  it("--rebuild refreshes the index before querying", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha original.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMarkdown({ id: "alpha", body: "Alpha changed.\n" }),
      );
      gitCommitAll(tv.dir, "edit alpha");

      const result = await searchQueryResolved(
        config,
        { query: "changed", mode: "fts", rebuild: true },
        { embedder },
      );
      expect(result.rebuilt).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      tv.cleanup();
    }
  });

  it("is not stale immediately after a build with no further changes", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchQueryResolved(
        config,
        { query: "alpha", mode: "fts" },
        { embedder },
      );
      expect(result.stale).toBe(false);
    } finally {
      tv.cleanup();
    }
  });

  it("flags staleness when the manifest's embedder no longer matches what the live config resolves to", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      await searchBuildResolved(config, {}, { embedder: createFakeEmbedder() });

      // No deps.embedder this time, and fts mode needs none at all, so the staleness check falls
      // back to comparing the manifest's recorded identity ("fake:8") against what the live
      // config would actually resolve to (fastembed's default) — they don't match. Without the
      // fix for this exact tautology, this compared the manifest against itself and could never
      // detect an embedder/config change.
      const result = await searchQueryResolved(config, { query: "alpha", mode: "fts" });
      expect(result.stale).toBe(true);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchQueryResolved — embedder mismatches", () => {
  it("fails clearly for vector mode against an FTS-only index, but fts mode still works", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Widgets galore.\n" }),
    });
    try {
      // No deps.embedder and no real network: build a genuinely FTS-only index by hand-writing a
      // manifest that claims the "fts-only" embedding identity, matching what build.ts records
      // when the real embedder is unavailable.
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const { readManifest, writeManifestAtomic } = await import(
        "../../../../../packages/semantic-layer/src/search/manifest.js"
      );
      const manifestFile = join(config.vaultDir, config.search.manifestFile);
      const manifest = readManifest(manifestFile);
      if (!manifest) throw new Error("expected a manifest");
      writeManifestAtomic(manifestFile, {
        ...manifest,
        embedding: { id: "fts-only", dimensions: 1 },
      });

      await expect(
        searchQueryResolved(config, { query: "widgets", mode: "vector" }, { embedder }),
      ).rejects.toThrow(/FTS-only/);

      const ftsResult = await searchQueryResolved(
        config,
        { query: "widgets", mode: "fts" },
        { embedder },
      );
      expect(ftsResult.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      tv.cleanup();
    }
  });

  it("fails clearly when the query embedder doesn't match the one the index was built with", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Widgets galore.\n" }),
    });
    try {
      await searchBuildResolved(config, {}, { embedder: createFakeEmbedder() });

      const mismatchedEmbedder = {
        id: "fake:different",
        dimensions: 8,
        embedDocuments: async (texts: string[]) => texts.map(() => new Array(8).fill(0)),
        embedQuery: async () => new Array(8).fill(0),
      };

      await expect(
        searchQueryResolved(
          config,
          { query: "widgets", mode: "vector" },
          { embedder: mismatchedEmbedder },
        ),
      ).rejects.toThrow(/was built with embedder/);
    } finally {
      tv.cleanup();
    }
  });
});
