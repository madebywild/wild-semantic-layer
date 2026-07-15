import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { search as searchIndex } from "@orama/orama";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../../../packages/semantic-layer/src/config.js";
import { searchBuildResolved } from "../../../../../packages/semantic-layer/src/search/build.js";
import {
  readManifest,
  writeManifestAtomic,
} from "../../../../../packages/semantic-layer/src/search/manifest.js";
import { loadIndex } from "../../../../../packages/semantic-layer/src/search/persistence.js";
import type { ResolvedConfig } from "../../../../../packages/semantic-layer/src/types.js";
import {
  createFakeEmbedder,
  createTempVault,
  gitCommitAll,
  initGitRepo,
  noteMarkdown as noteMd,
} from "../../../../helpers.js";

function setupVault(files: Record<string, string>) {
  const tv = createTempVault({
    "vault/root.md": noteMd({ id: "root", body: "# Root\n" }),
    ...files,
  });
  const config = loadConfig({ cwd: tv.dir });
  return { tv, config };
}

async function chunkIdsFor(config: ResolvedConfig, noteId: string): Promise<string[]> {
  const index = await loadIndex(join(config.vaultDir, config.search.indexFile));
  if (!index) return [];
  const results = await searchIndex(index, { term: "", where: { noteId: { eq: noteId } } });
  return results.hits.map((hit) => hit.id).sort();
}

describe("searchBuildResolved — full rebuild", () => {
  it("builds an index and manifest with correct counts and searchable content", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({
        id: "alpha",
        body: "## Section\n\nAlpha content about widgets.\n",
      }),
      "vault/beta.md": noteMd({ id: "beta", body: "## Section\n\nBeta content about gadgets.\n" }),
    });
    try {
      const result = await searchBuildResolved(config, {}, { embedder: createFakeEmbedder() });

      expect(result.mode).toBe("full");
      expect(result.ftsOnly).toBe(false);
      expect(result.noteCount).toBe(3);
      expect(result.notesRemoved).toBe(0);
      expect(existsSync(result.indexFile)).toBe(true);
      expect(existsSync(result.manifestFile)).toBe(true);

      const index = await loadIndex(result.indexFile);
      if (!index) throw new Error("expected a persisted index");
      const hits = (await searchIndex(index, { term: "widgets" })).hits;
      expect(hits.map((hit) => hit.document.noteId)).toContain("alpha");

      const manifest = readManifest(result.manifestFile);
      expect(manifest?.noteCount).toBe(3);
      expect(manifest?.chunkCount).toBe(result.chunkCount);
      expect(manifest?.embedding).toEqual({ id: "fake:8", dimensions: 8 });
      expect(Object.keys(manifest?.noteContentHashes ?? {}).sort()).toEqual([
        "alpha",
        "beta",
        "root",
      ]);
    } finally {
      tv.cleanup();
    }
  });

  it("skips notes with invalid frontmatter", async () => {
    const { tv, config } = setupVault({
      "vault/bad.md": "---\nid: bad\n---\n\n# Missing required fields\n",
    });
    try {
      const result = await searchBuildResolved(config, {}, { embedder: createFakeEmbedder() });
      expect(result.noteCount).toBe(1);
      const manifest = readManifest(result.manifestFile);
      expect(manifest?.noteContentHashes.bad).toBeUndefined();
    } finally {
      tv.cleanup();
    }
  });

  it("propagates a non-fastembed embedder error instead of silently degrading to FTS-only", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    const { tv, config } = setupVault({});
    try {
      const geminiConfig: ResolvedConfig = {
        ...config,
        search: { ...config.search, embedding: { provider: "gemini" } },
      };
      await expect(searchBuildResolved(geminiConfig, {}, {})).rejects.toThrow(
        /requires an API key/,
      );
    } finally {
      tv.cleanup();
      vi.unstubAllEnvs();
    }
  });

  it("refuses to build when search.enabled is false", async () => {
    const { tv, config } = setupVault({});
    try {
      const disabledConfig: ResolvedConfig = {
        ...config,
        search: { ...config.search, enabled: false },
      };
      await expect(
        searchBuildResolved(disabledConfig, {}, { embedder: createFakeEmbedder() }),
      ).rejects.toThrow(/search is disabled/);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchBuildResolved — incremental rebuild", () => {
  it("is a no-op when nothing changed since the last build", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      expect(first.mode).toBe("full");

      const second = await searchBuildResolved(config, {}, { embedder });
      expect(second.mode).toBe("incremental");
      expect(second.notesIndexed).toBe(0);
      expect(second.notesRemoved).toBe(0);
      expect(second.chunkCount).toBe(first.chunkCount);
    } finally {
      tv.cleanup();
    }
  });

  it("reindexes only the note whose content changed in a commit, leaving other notes' chunks untouched", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha original.\n" }),
      "vault/beta.md": noteMd({ id: "beta", body: "Beta original.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });
      const betaIdsBefore = await chunkIdsFor(config, "beta");

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMd({ id: "alpha", body: "Alpha changed.\n" }),
      );
      gitCommitAll(tv.dir, "edit alpha");

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesIndexed).toBe(1);
      expect(result.notesRemoved).toBe(0);

      const index = await loadIndex(result.indexFile);
      if (!index) throw new Error("expected a persisted index");
      const changedHits = (await searchIndex(index, { term: "changed" })).hits;
      expect(changedHits.map((hit) => hit.document.noteId)).toContain("alpha");
      const staleHits = (await searchIndex(index, { term: "original" })).hits.filter(
        (hit) => hit.document.noteId === "alpha",
      );
      expect(staleHits).toHaveLength(0);

      expect(await chunkIdsFor(config, "beta")).toEqual(betaIdsBefore);
    } finally {
      tv.cleanup();
    }
  });

  it("detects an uncommitted edit to a tracked note", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha original.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        noteMd({ id: "alpha", body: "Alpha uncommitted edit.\n" }),
      );

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesIndexed).toBe(1);
    } finally {
      tv.cleanup();
    }
  });

  it("removes a note deleted in a commit", async () => {
    const { tv, config } = setupVault({
      "vault/gone.md": noteMd({ id: "gone", body: "Going away.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      expect(first.noteCount).toBe(2);

      rmSync(join(tv.vaultDir, "gone.md"));
      gitCommitAll(tv.dir, "remove gone");

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesRemoved).toBe(1);
      expect(result.noteCount).toBe(1);
      expect(await chunkIdsFor(config, "gone")).toEqual([]);
      const manifest = readManifest(result.manifestFile);
      expect(manifest?.noteContentHashes.gone).toBeUndefined();
    } finally {
      tv.cleanup();
    }
  });

  it("treats a git rename as a removal of the old id and an addition of the new one", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      execFileSync("git", ["mv", "vault/alpha.md", "vault/gamma.md"], {
        cwd: tv.dir,
        stdio: "ignore",
      });
      writeFileSync(
        join(tv.vaultDir, "gamma.md"),
        noteMd({ id: "gamma", body: "Alpha content.\n" }),
      );
      gitCommitAll(tv.dir, "rename alpha to gamma");

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesRemoved).toBe(1);
      expect(result.notesIndexed).toBe(1);
      expect(await chunkIdsFor(config, "alpha")).toEqual([]);
      expect(await chunkIdsFor(config, "gamma")).not.toEqual([]);

      const manifest = readManifest(result.manifestFile);
      expect(manifest?.noteContentHashes.alpha).toBeUndefined();
      expect(manifest?.noteContentHashes.gamma).toBeDefined();
    } finally {
      tv.cleanup();
    }
  });

  it("removes a note whose frontmatter becomes invalid in a commit", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha content.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      expect(first.noteCount).toBe(2);

      writeFileSync(
        join(tv.vaultDir, "alpha.md"),
        "---\nid: alpha\n---\n\n# Missing required fields\n",
      );
      gitCommitAll(tv.dir, "break alpha frontmatter");

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesRemoved).toBe(1);
      expect(result.noteCount).toBe(1);
      expect(await chunkIdsFor(config, "alpha")).toEqual([]);
      expect(readManifest(result.manifestFile)?.noteContentHashes.alpha).toBeUndefined();
    } finally {
      tv.cleanup();
    }
  });

  it("detects a fully untracked new note", async () => {
    const { tv, config } = setupVault({});
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      writeFileSync(join(tv.vaultDir, "new.md"), noteMd({ id: "new", body: "Brand new note.\n" }));

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesIndexed).toBe(1);
      expect(result.noteCount).toBe(2);
    } finally {
      tv.cleanup();
    }
  });

  it("skips reindexing when a note is flagged by git but its content hash already matches the manifest", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha v1.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      // Edit uncommitted, index it (hash recorded for the new content while HEAD is unmoved)...
      writeFileSync(join(tv.vaultDir, "alpha.md"), noteMd({ id: "alpha", body: "Alpha v2.\n" }));
      const middle = await searchBuildResolved(config, {}, { embedder });
      expect(middle.notesIndexed).toBe(1);

      // ...then commit that exact same content. The manifest's stored SHA now predates a commit
      // that touches alpha.md, so it becomes a candidate again — but its content hasn't actually
      // changed since it was already indexed, so it should be skipped.
      gitCommitAll(tv.dir, "commit the already-indexed edit");

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("incremental");
      expect(result.notesIndexed).toBe(0);
      expect(result.notesRemoved).toBe(0);
    } finally {
      tv.cleanup();
    }
  });
});

describe("searchBuildResolved — fallback to full rebuild", () => {
  it("forces a full rebuild when --full is passed, even with a compatible manifest", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      const result = await searchBuildResolved(config, { full: true }, { embedder });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when the repo's git metadata is gone", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      expect(readManifest(first.manifestFile)?.lastIndexedSha).toBeDefined();

      rmSync(join(tv.dir, ".git"), { recursive: true, force: true });

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when the stored SHA is no longer an ancestor of HEAD", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      await searchBuildResolved(config, {}, { embedder });

      // A distinct message guarantees a genuinely different commit object (and thus a different
      // SHA) regardless of whether the amend happens to land in the same second as the original.
      execFileSync("git", ["commit", "--amend", "-m", "initial (amended)"], {
        cwd: tv.dir,
        stdio: "ignore",
      });

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when the embedder's dimensions no longer match the manifest", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      await searchBuildResolved(config, {}, { embedder: createFakeEmbedder(8) });

      const result = await searchBuildResolved(config, {}, { embedder: createFakeEmbedder(16) });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when the index file is missing despite a valid, compatible manifest", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      rmSync(first.indexFile);

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("full");
      expect(existsSync(result.indexFile)).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when there is no manifest yet", async () => {
    const { tv, config } = setupVault({});
    try {
      const result = await searchBuildResolved(config, {}, { embedder: createFakeEmbedder() });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });

  it("falls back to full when a hand-written manifest is missing a stored SHA", async () => {
    const { tv, config } = setupVault({
      "vault/alpha.md": noteMd({ id: "alpha", body: "Alpha.\n" }),
    });
    try {
      initGitRepo(tv.dir);
      gitCommitAll(tv.dir, "initial");
      const embedder = createFakeEmbedder();
      const first = await searchBuildResolved(config, {}, { embedder });
      const manifest = readManifest(first.manifestFile);
      if (!manifest) throw new Error("expected a manifest");
      writeManifestAtomic(first.manifestFile, { ...manifest, lastIndexedSha: undefined });

      const result = await searchBuildResolved(config, {}, { embedder });
      expect(result.mode).toBe("full");
    } finally {
      tv.cleanup();
    }
  });
});
