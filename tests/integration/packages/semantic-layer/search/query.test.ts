import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSearch } from "../../../../../packages/semantic-layer/src/commands/search.js";
import { loadConfig } from "../../../../../packages/semantic-layer/src/config.js";
import { withConnectionForConfig } from "../../../../../packages/semantic-layer/src/db/connection.js";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import {
  readIndexMeta,
  writeIndexMeta,
} from "../../../../../packages/semantic-layer/src/db/meta.js";
import { querySearch } from "../../../../../packages/semantic-layer/src/db/queries/search.js";
import type { ResolvedConfig } from "../../../../../packages/semantic-layer/src/types.js";
import type { TempVault } from "../../../../helpers.js";
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

function cleanup(_tv: TempVault): void {
  // Intentionally a no-op: LadybugDB 0.18.2's native close can return before the WAL checkpoint
  // is fully finished, and deleting the temp directory while checkpointing is still in progress
  // races with the filesystem and flakes/corrupts later tests. Rely on the OS /tmp cleaner.
}

// LadybugDB 0.18.2's FTS tokenizer does not treat newlines as separators, so tokens touching a
// line break would fuse into unsearchable compounds; the indexer stores a newline-normalized
// `searchText` copy for FTS (see schema.ts/insert.ts and the pinning test in
// indexer/full-rebuild.test.ts). These fixtures deliberately put the searched term mid-line
// anyway, so they assert plain FTS behavior and stay meaningful even if the quirk is fixed
// upstream and the normalization is removed.
const SEARCHABLE_WIDGETS_BODY = "## Section\n\nThe widgets are great.\n";

describe("querySearch — cold start", () => {
  it("builds an index automatically when none exists yet, then queries it", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      const result = await querySearch(
        config,
        { query: "widgets" },
        { embedder: createFakeEmbedder() },
      );
      expect(result.rebuilt).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      await cleanup(tv);
    }
  });

  it("runSearch loads config from disk and queries the index", async () => {
    const { tv } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      const result = await runSearch({
        cwd: tv.dir,
        query: "widgets",
        mode: "fts",
        embedder: createFakeEmbedder(),
      });
      expect(result.mode).toBe("fts");
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      await cleanup(tv);
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
        querySearch(disabledConfig, { query: "anything" }, { embedder: createFakeEmbedder() }),
      ).rejects.toThrow(/search is disabled/);
    } finally {
      await cleanup(tv);
    }
  });
});

describe("querySearch — modes", () => {
  it("fts mode matches on text content", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
      "vault/beta.md": noteMarkdown({ id: "beta", body: "## Section\n\nThe gadgets are here.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(config, { query: "widgets", mode: "fts" }, { embedder });
      expect(result.mode).toBe("fts");
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
      expect(result.hits.map((hit) => hit.noteId)).not.toContain("beta");
    } finally {
      await cleanup(tv);
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
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(
        config,
        { query: "Section\n\nA very specific phrase.", mode: "vector" },
        { embedder },
      );
      expect(result.mode).toBe("vector");
      expect(result.hits[0]?.noteId).toBe("alpha");
    } finally {
      await cleanup(tv);
    }
  });

  it("uses a permissive similarity threshold so a real-world-scale match still surfaces", async () => {
    const { tv, config } = setupVault({
      "vault/target.md": noteMarkdown({ id: "target", body: "TARGET_MARKER content.\n" }),
    });
    try {
      // A controlled embedder: the target note's vector and the query vector have an exact
      // cosine similarity of 0.5 (query = [0.5, √3/2], target = [1, 0]) — above this package's
      // 0.4 default, but below a stricter near-duplicate threshold like 0.8. Every other chunk
      // maps to [0, -1] (cosine -0.866 against the query, distance 1.866 > 0.6), so it can only
      // surface via this threshold.
      const embedder = {
        id: "fake:controlled",
        dimensions: 2,
        embedDocuments: async (texts: string[]) =>
          texts.map((text) => (text.includes("TARGET_MARKER") ? [1, 0] : [0, -1])),
        embedQuery: async () => [0.5, Math.sqrt(3) / 2],
      };
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(config, { query: "anything", mode: "vector" }, { embedder });
      expect(result.hits.map((hit) => hit.noteId)).toContain("target");
    } finally {
      await cleanup(tv);
    }
  });

  it("hybrid mode combines fts and vector signals without error", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(config, { query: "widgets", mode: "hybrid" }, { embedder });
      expect(result.mode).toBe("hybrid");
      expect(result.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      await cleanup(tv);
    }
  });

  it("defaults to the config's defaultMode when mode is not specified", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(config, { query: "widgets" }, { embedder });
      expect(result.mode).toBe(config.search.defaultMode);
    } finally {
      await cleanup(tv);
    }
  });
});

describe("querySearch — filters", () => {
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

The widgets content.
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

The widgets content too.
`,
    });
    try {
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const byStatus = await querySearch(
        config,
        { query: "widgets", mode: "fts", status: "active" },
        { embedder },
      );
      expect(byStatus.hits.map((hit) => hit.noteId)).toEqual(["beta"]);

      const byTag = await querySearch(
        config,
        { query: "widgets", mode: "fts", tags: ["widgets"] },
        { embedder },
      );
      expect(byTag.hits.map((hit) => hit.noteId)).toEqual(["alpha"]);

      const byAudience = await querySearch(
        config,
        { query: "widgets", mode: "fts", audience: ["agents"] },
        { embedder },
      );
      expect(byAudience.hits.map((hit) => hit.noteId)).toEqual(["beta"]);
    } finally {
      await cleanup(tv);
    }
  });

  it("respects an explicit limit", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "The widgets number one.\n" }),
      "vault/beta.md": noteMarkdown({ id: "beta", body: "The widgets number two.\n" }),
      "vault/gamma.md": noteMarkdown({ id: "gamma", body: "The widgets number three.\n" }),
    });
    try {
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const result = await querySearch(
        config,
        { query: "widgets", mode: "fts", limit: 1 },
        { embedder },
      );
      expect(result.hits).toHaveLength(1);
    } finally {
      await cleanup(tv);
    }
  });
});

describe("querySearch — staleness and rebuild", () => {
  // LadybugDB 0.18.2's native close can return before its WAL checkpoint is finished. Running the
  // staleness/rebuild scenarios inside a single vault and a single test body keeps open/close
  // cycles to a minimum and avoids the cross-test checkpoint races that flake when every scenario
  // spins up its own temp database.
  it("detects staleness, rebuilds on demand, and reports a fresh index", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha original.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();

      // Reuse a single LadybugDB connection for every query in this scenario to avoid the WAL
      // checkpoint race that flakes when the same test opens and closes the database repeatedly.
      await withConnectionForConfig(config, async (conn) => {
        // Cold-build the index and sanity-check that the original content is searchable.
        const coldResult = await querySearch(
          config,
          { query: "original", mode: "fts" },
          { embedder, connection: conn },
        );
        expect(coldResult.rebuilt).toBe(true);
        expect(coldResult.hits.map((hit) => hit.noteId)).toContain("alpha");

        // Change the note and commit again.
        writeFileSync(
          join(tv.vaultDir, "alpha.md"),
          noteMarkdown({ id: "alpha", body: "Alpha changed.\n" }),
        );
        gitCommitAll(tv.dir, "edit alpha");

        // A query without rebuilding sees the stale warning but still searches the old index.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const staleResult = await querySearch(
          config,
          { query: "original", mode: "fts" },
          { embedder, connection: conn },
        );
        expect(staleResult.stale).toBe(true);
        expect(staleResult.rebuilt).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("results"));
        errorSpy.mockRestore();

        // A query with --rebuild refreshes the index and finds the new content.
        const rebuiltResult = await querySearch(
          config,
          { query: "changed", mode: "fts", rebuild: true },
          { embedder, connection: conn },
        );
        expect(rebuiltResult.rebuilt).toBe(true);
        expect(rebuiltResult.stale).toBe(false);
        expect(rebuiltResult.hits.map((hit) => hit.noteId)).toContain("alpha");

        // Immediately after a rebuild, the index is fresh again.
        const freshResult = await querySearch(
          config,
          { query: "changed", mode: "fts" },
          { embedder, connection: conn },
        );
        expect(freshResult.stale).toBe(false);
      });
    } finally {
      await cleanup(tv);
    }
  });

  it("flags staleness when the meta's embedder no longer matches what the live config resolves to", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      // No deps.embedder this time, and fts mode needs none at all, so the staleness check falls
      // back to comparing the meta's recorded identity ("fake:8") against what the live config
      // would actually resolve to (fastembed's default) — they don't match.
      const result = await querySearch(config, { query: "alpha", mode: "fts" });
      expect(result.stale).toBe(true);
    } finally {
      await cleanup(tv);
    }
  });
});

describe("querySearch — embedder mismatches", () => {
  it("fails clearly for vector and hybrid modes against an FTS-only index, but fts mode still works", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      // Build a normal index, then hand-rewrite the meta sidecar to claim the "fts-only"
      // embedding identity, matching what the indexer records when the real embedder is
      // unavailable on the build platform.
      const embedder = createFakeEmbedder();
      await buildIndex(config, {}, { embedder });

      const meta = readIndexMeta(config);
      if (!meta) throw new Error("expected an index meta sidecar");
      writeIndexMeta(config, { ...meta, embedding: { kind: "fts-only" } });

      await expect(
        querySearch(config, { query: "widgets", mode: "vector" }, { embedder }),
      ).rejects.toThrow(/FTS-only/);
      await expect(
        querySearch(config, { query: "widgets", mode: "hybrid" }, { embedder }),
      ).rejects.toThrow(/FTS-only/);

      const ftsResult = await querySearch(config, { query: "widgets", mode: "fts" }, { embedder });
      expect(ftsResult.hits.map((hit) => hit.noteId)).toContain("alpha");
    } finally {
      await cleanup(tv);
    }
  });

  it("fails clearly when the query embedder doesn't match the one the index was built with", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMarkdown({ id: "alpha", body: SEARCHABLE_WIDGETS_BODY }),
    });
    try {
      await buildIndex(config, {}, { embedder: createFakeEmbedder() });

      const mismatchedEmbedder = {
        id: "fake:different",
        dimensions: 8,
        embedDocuments: async (texts: string[]) => texts.map(() => new Array(8).fill(0)),
        embedQuery: async () => new Array(8).fill(0),
      };

      await expect(
        querySearch(config, { query: "widgets", mode: "vector" }, { embedder: mismatchedEmbedder }),
      ).rejects.toThrow(/was built with embedder/);
    } finally {
      await cleanup(tv);
    }
  });
});
