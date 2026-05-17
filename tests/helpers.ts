import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
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
    index: { file: "HIERARCHY.md" },
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
    index: { file: "HIERARCHY.md" },
    frontmatter: { requiredExtraFields: [] },
    externalInvariants: [],
    evolution: { stagingDir: "vault/.semantic-layer/refinements" },
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
