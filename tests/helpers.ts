import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { DEFAULT_SEARCH_CONFIG } from "../packages/semantic-layer/src/config.js";
import type { Embedder } from "../packages/semantic-layer/src/search/embedder.js";
import type { ResolvedConfig } from "../packages/semantic-layer/src/types.js";

export type TempVault = {
  dir: string;
  vaultDir: string;
  repoRoot: string;
  cleanup: () => void;
};

/**
 * Creates a temp directory with arbitrary files. Returns the directory path
 * and a cleanup function that removes it.
 */
export function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sl-test-"));
  return { dir, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}

/**
 * Creates a temp directory structure for a vault-based test.
 * Writes a semantic-layer.config.yml and any files specified.
 * Returns paths and a cleanup function.
 */
export function createTempVault(
  files: Record<string, string>,
  config?: Record<string, unknown>,
): TempVault {
  const { dir, cleanup } = createTempDir();
  const vaultDir = join(dir, "vault");
  mkdirSync(vaultDir, { recursive: true });

  // Write config
  const fullConfig = {
    vault: "vault",
    root: ".",
    index: { file: "HIERARCHY.md", codeRefsFile: ".semantic-layer/code-refs.json" },
    frontmatter: { requiredExtraFields: [] },
    externalInvariants: [],
    evolution: { stagingDir: "vault/.semantic-layer/refinements" },
    ...config,
  };
  writeFileSync(join(dir, "semantic-layer.config.yml"), yamlStringify(fullConfig));

  // Write files
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  return { dir, vaultDir, repoRoot: dir, cleanup };
}

/**
 * Creates a ResolvedConfig with sensible defaults, merged with overrides.
 */
export function createResolvedConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    vault: "vault",
    root: ".",
    index: { file: "HIERARCHY.md", codeRefsFile: ".semantic-layer/code-refs.json" },
    frontmatter: { requiredExtraFields: [] },
    externalInvariants: [],
    evolution: { stagingDir: "vault/.semantic-layer/refinements" },
    search: DEFAULT_SEARCH_CONFIG,
    configFile: undefined,
    repoRoot: overrides?.repoRoot ?? "/tmp/test-repo",
    vaultDir: overrides?.vaultDir ?? "/tmp/test-repo/vault",
    refinementDir: overrides?.refinementDir ?? "/tmp/test-repo/vault/.semantic-layer/refinements",
    ...overrides,
  };
}

/**
 * Filters check result errors by a regex pattern.
 */
export function collectErrors(errors: string[], pattern: RegExp): string[] {
  return errors.filter((e) => pattern.test(e));
}

/**
 * Initializes a real git repo at `dir` with a deterministic local identity and no GPG signing, so
 * tests can exercise real git plumbing (used by git-diff and incremental-rebuild tests).
 */
export function initGitRepo(dir: string): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
}

/** Stages every change in `dir` and commits it, returning the new commit's SHA. */
export function gitCommitAll(dir: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/**
 * A fast, deterministic `Embedder` for search tests: same text always maps to the same vector, no
 * network or ONNX involved. Not semantically meaningful — just distinct enough for the pipeline
 * (chunking → embed → insert → search) to be exercised end to end.
 */
export function createFakeEmbedder(dimensions = 8): Embedder {
  return {
    id: `fake:${dimensions}`,
    dimensions,
    embedDocuments: (texts) => Promise.resolve(texts.map((text) => fakeVector(text, dimensions))),
    embedQuery: (text) => Promise.resolve(fakeVector(text, dimensions)),
  };
}

function fakeVector(text: string, dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    vector[i % dimensions] += text.charCodeAt(i);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

/** Renders a minimal valid vault note (frontmatter + body) for search-index test fixtures. */
export function noteMarkdown(options: {
  id: string;
  title?: string;
  desc?: string;
  body?: string;
}): string {
  const title = options.title ?? options.id;
  const desc = options.desc ?? `${title} description.`;
  return `---
id: ${options.id}
title: ${title}
desc: ${desc}
status: active
owner: tester@example.com
last_verified: 2026-05-13
ttl_days: 365
---

${options.body ?? `# ${title}\n\nSome content about ${title}.\n`}`;
}
