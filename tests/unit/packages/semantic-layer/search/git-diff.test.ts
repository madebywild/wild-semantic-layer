import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  candidateNoteIdsSinceSha,
  diffVaultFilesSinceSha,
  getHeadSha,
  isAncestorOfHead,
} from "../../../../../packages/semantic-layer/src/search/git-diff.js";
import { createTempDir, gitCommitAll, initGitRepo } from "../../../../helpers.js";

// Real git subprocesses, not mocks — occasionally slower than the unit project's 5s default
// under heavy parallel load (many concurrent test files spawning git themselves).
vi.setConfig({ testTimeout: 15_000 });

function writeVaultFile(dir: string, relativePath: string, content: string) {
  const fullPath = join(dir, "vault", relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

describe("getHeadSha", () => {
  it("returns undefined for a non-git directory", () => {
    const { dir, cleanup } = createTempDir();
    try {
      expect(getHeadSha(dir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns undefined for a git repo with no commits yet", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      expect(getHeadSha(dir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns the current commit sha", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const sha = gitCommitAll(dir, "initial commit");
      expect(getHeadSha(dir)).toBe(sha);
    } finally {
      cleanup();
    }
  });
});

describe("isAncestorOfHead", () => {
  it("is true for an earlier commit and for HEAD itself", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const first = gitCommitAll(dir, "first");
      writeVaultFile(dir, "root.md", "# Root v2\n");
      const second = gitCommitAll(dir, "second");

      expect(isAncestorOfHead(dir, first)).toBe(true);
      expect(isAncestorOfHead(dir, second)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("is false for an unknown sha", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      gitCommitAll(dir, "initial");
      expect(isAncestorOfHead(dir, "0".repeat(40))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("is false when repoRoot isn't a git repo", () => {
    const { dir, cleanup } = createTempDir();
    try {
      expect(isAncestorOfHead(dir, "0".repeat(40))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("diffVaultFilesSinceSha", () => {
  it("detects a committed change to a vault note between two commits", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeVaultFile(dir, "other.md", "# Other\n");
      const first = gitCommitAll(dir, "first");
      writeVaultFile(dir, "root.md", "# Root changed\n");
      gitCommitAll(dir, "second");

      const diff = diffVaultFilesSinceSha(dir, join(dir, "vault"), first);
      expect(diff).toEqual(["root.md"]);
    } finally {
      cleanup();
    }
  });

  it("detects an uncommitted, unstaged modification to a tracked file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const sha = gitCommitAll(dir, "initial");
      writeVaultFile(dir, "root.md", "# Root changed uncommitted\n");

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["root.md"]);
    } finally {
      cleanup();
    }
  });

  it("detects a staged-but-uncommitted new file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const sha = gitCommitAll(dir, "initial");
      writeVaultFile(dir, "staged.md", "# Staged\n");
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["staged.md"]);
    } finally {
      cleanup();
    }
  });

  it("detects a fully untracked new file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const sha = gitCommitAll(dir, "initial");
      writeVaultFile(dir, "untracked.md", "# Untracked\n");

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["untracked.md"]);
    } finally {
      cleanup();
    }
  });

  it("detects a committed deletion", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeVaultFile(dir, "gone.md", "# Gone\n");
      const first = gitCommitAll(dir, "first");
      rmSync(join(dir, "vault", "gone.md"));
      gitCommitAll(dir, "second");

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), first)).toEqual(["gone.md"]);
    } finally {
      cleanup();
    }
  });

  it("detects an uncommitted deletion of a tracked file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeVaultFile(dir, "gone.md", "# Gone\n");
      const sha = gitCommitAll(dir, "initial");
      rmSync(join(dir, "vault", "gone.md"));

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["gone.md"]);
    } finally {
      cleanup();
    }
  });

  it("ignores changes outside the vault directory", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeFileSync(join(dir, "README.md"), "# Repo readme\n");
      const sha = gitCommitAll(dir, "initial");
      writeFileSync(join(dir, "README.md"), "# Changed readme\n");
      writeVaultFile(dir, "root.md", "# Root changed\n");

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["root.md"]);
    } finally {
      cleanup();
    }
  });

  it("returns a deduplicated, sorted list", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeVaultFile(dir, "zeta.md", "# Zeta\n");
      const sha = gitCommitAll(dir, "initial");
      writeVaultFile(dir, "zeta.md", "# Zeta changed\n");
      writeVaultFile(dir, "root.md", "# Root changed\n");

      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), sha)).toEqual(["root.md", "zeta.md"]);
    } finally {
      cleanup();
    }
  });

  it("returns an empty array for an unrelated sha that isn't an ancestor of HEAD", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      gitCommitAll(dir, "initial");

      // `git diff --name-status` still works between any two valid revisions, ancestor or not —
      // callers are expected to gate on `isAncestorOfHead` themselves before trusting this diff.
      expect(diffVaultFilesSinceSha(dir, join(dir, "vault"), "0".repeat(40))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("candidateNoteIdsSinceSha", () => {
  it("narrows candidates to note ids, dropping non-.md paths and HIERARCHY.md", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      writeVaultFile(dir, "root.schema.yml", "version: 1\n");
      writeVaultFile(dir, "HIERARCHY.md", "<!-- autogenerated -->\n");
      const sha = gitCommitAll(dir, "initial");

      writeVaultFile(dir, "root.md", "# Root changed\n");
      writeVaultFile(dir, "root.schema.yml", "version: 2\n");
      writeVaultFile(dir, "HIERARCHY.md", "<!-- regenerated -->\n");

      expect(candidateNoteIdsSinceSha(dir, join(dir, "vault"), sha)).toEqual(["root"]);
    } finally {
      cleanup();
    }
  });

  it("ignores untracked search-index artifacts even without a matching .gitignore entry", () => {
    const { dir, cleanup } = createTempDir();
    try {
      initGitRepo(dir);
      writeVaultFile(dir, "root.md", "# Root\n");
      const sha = gitCommitAll(dir, "initial");

      // Simulates a consuming repo that hasn't picked up the recommended .gitignore entries yet:
      // these generated artifacts sit untracked right next to real vault notes.
      writeVaultFile(dir, ".semantic-layer/search-index.msp", "binary-ish content");
      writeVaultFile(dir, ".semantic-layer/search-index.manifest.json", "{}");

      expect(candidateNoteIdsSinceSha(dir, join(dir, "vault"), sha)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("diffVaultFilesSinceSha — repoRoot as a monorepo subdirectory", () => {
  // `repoRoot` (the cwd git runs in) is often a package subdirectory, not the git top-level —
  // e.g. a monorepo app with its own `root: .` pointing at itself. `git diff --name-status`
  // prints paths relative to the true top-level by default, not to cwd, unlike `git ls-files`;
  // getting this wrong silently drops every candidate found this way.
  function writePackageVaultFile(repoRoot: string, relativePath: string, content: string) {
    const fullPath = join(repoRoot, "vault", relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }

  it("resolves candidates correctly when repoRoot is a subdirectory of the git top-level", () => {
    const { dir: gitRoot, cleanup } = createTempDir();
    try {
      initGitRepo(gitRoot);
      const repoRoot = join(gitRoot, "packages", "app");
      mkdirSync(repoRoot, { recursive: true });
      writePackageVaultFile(repoRoot, "root.md", "# Root\n");
      writePackageVaultFile(repoRoot, "other.md", "# Other\n");
      const sha = gitCommitAll(gitRoot, "initial");

      writePackageVaultFile(repoRoot, "root.md", "# Root changed\n");

      expect(candidateNoteIdsSinceSha(repoRoot, join(repoRoot, "vault"), sha)).toEqual(["root"]);
    } finally {
      cleanup();
    }
  });

  it("detects a committed change made from outside the package subdirectory", () => {
    const { dir: gitRoot, cleanup } = createTempDir();
    try {
      initGitRepo(gitRoot);
      const repoRoot = join(gitRoot, "packages", "app");
      mkdirSync(repoRoot, { recursive: true });
      writePackageVaultFile(repoRoot, "root.md", "# Root\n");
      const sha = gitCommitAll(gitRoot, "initial");

      writePackageVaultFile(repoRoot, "root.md", "# Root changed\n");
      gitCommitAll(gitRoot, "edit root");

      expect(candidateNoteIdsSinceSha(repoRoot, join(repoRoot, "vault"), sha)).toEqual(["root"]);
    } finally {
      cleanup();
    }
  });

  it("detects an untracked new note in the package subdirectory", () => {
    const { dir: gitRoot, cleanup } = createTempDir();
    try {
      initGitRepo(gitRoot);
      const repoRoot = join(gitRoot, "packages", "app");
      mkdirSync(repoRoot, { recursive: true });
      writePackageVaultFile(repoRoot, "root.md", "# Root\n");
      const sha = gitCommitAll(gitRoot, "initial");

      writePackageVaultFile(repoRoot, "new.md", "# New\n");

      expect(candidateNoteIdsSinceSha(repoRoot, join(repoRoot, "vault"), sha)).toEqual(["new"]);
    } finally {
      cleanup();
    }
  });
});
