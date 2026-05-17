import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../../packages/semantic-layer/src/config.js";
import { createTempDir } from "../../../helpers.js";

function writeYamlConfig(dir: string, content: string, name = "semantic-layer.config.yml"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function writeJsonConfig(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "semantic-layer.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("vault");
      expect(config.root).toBe(".");
      expect(config.index.file).toBe("HIERARCHY.md");
      expect(config.frontmatter.requiredExtraFields).toEqual([]);
      expect(config.externalInvariants).toEqual([]);
      expect(config.evolution.stagingDir).toBe("vault/.semantic-layer/refinements");
      expect(config.refinementDir).toBe(join(dir, "vault/.semantic-layer/refinements"));
      expect(config.configFile).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("discovers semantic-layer.config.yml", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: docs\nroot: .\n");
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("docs");
      expect(config.configFile).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("discovers semantic-layer.config.yaml", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: docs\nroot: .\n", "semantic-layer.config.yaml");
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("docs");
      expect(config.evolution.stagingDir).toBe("docs/.semantic-layer/refinements");
    } finally {
      cleanup();
    }
  });

  it("discovers semantic-layer.config.json", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeJsonConfig(dir, { vault: "docs", root: "." });
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("docs");
    } finally {
      cleanup();
    }
  });

  it("prefers .yml over .yaml and .json", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: from-yml\nroot: .\n", "semantic-layer.config.yml");
      writeYamlConfig(dir, "vault: from-yaml\nroot: .\n", "semantic-layer.config.yaml");
      writeJsonConfig(dir, { vault: "from-json", root: "." });
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("from-yml");
    } finally {
      cleanup();
    }
  });

  it("allows explicit configPath override", () => {
    const { dir, cleanup } = createTempDir();
    try {
      // Write config in a subdirectory
      mkdirSync(join(dir, "custom"), { recursive: true });
      writeFileSync(join(dir, "custom", "my-config.yml"), "vault: custom-vault\nroot: .\n");
      const config = loadConfig({ cwd: dir, configPath: "custom/my-config.yml" });
      expect(config.vault).toBe("custom-vault");
    } finally {
      cleanup();
    }
  });

  it("CLI vault option overrides config file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: docs\nroot: .\n");
      const config = loadConfig({ cwd: dir, vault: "my-vault" });
      expect(config.vault).toBe("my-vault");
      expect(config.evolution.stagingDir).toBe("my-vault/.semantic-layer/refinements");
    } finally {
      cleanup();
    }
  });

  it("CLI root option overrides config file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: vault\nroot: .\n");
      const config = loadConfig({ cwd: dir, root: "packages/my-app" });
      expect(config.root).toBe("packages/my-app");
    } finally {
      cleanup();
    }
  });

  it("merges partial config with defaults", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: docs\n");
      const config = loadConfig({ cwd: dir });
      expect(config.vault).toBe("docs");
      expect(config.index.file).toBe("HIERARCHY.md");
      expect(config.frontmatter.requiredExtraFields).toEqual([]);
      expect(config.evolution.stagingDir).toBe("docs/.semantic-layer/refinements");
    } finally {
      cleanup();
    }
  });

  it("resolves vaultDir relative to config file directory", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: my-docs\nroot: .\n");
      const config = loadConfig({ cwd: dir });
      expect(config.vaultDir).toContain("my-docs");
      expect(config.vaultDir.startsWith(dir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("preserves externalInvariants from config file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(
        dir,
        [
          "vault: vault",
          "root: .",
          "externalInvariants:",
          "  - id: version",
          '    value: "2.0.0"',
          "    usedIn:",
          "      - my-note",
        ].join("\n"),
      );
      const config = loadConfig({ cwd: dir });
      expect(config.externalInvariants).toHaveLength(1);
      expect(config.externalInvariants[0]?.id).toBe("version");
      expect(config.externalInvariants[0]?.value).toBe("2.0.0");
      expect(config.externalInvariants[0]?.usedIn).toEqual(["my-note"]);
    } finally {
      cleanup();
    }
  });

  it("resolves repoRoot from config file directory", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: vault\nroot: .\n");
      const config = loadConfig({ cwd: dir });
      expect(config.repoRoot).toBe(dir);
    } finally {
      cleanup();
    }
  });

  it("preserves explicit evolution stagingDir from config file", () => {
    const { dir, cleanup } = createTempDir();
    try {
      writeYamlConfig(dir, "vault: vault\nevolution:\n  stagingDir: .semantic-layer/refinements\n");
      const config = loadConfig({ cwd: dir });
      expect(config.evolution.stagingDir).toBe(".semantic-layer/refinements");
      expect(config.refinementDir).toBe(join(dir, ".semantic-layer/refinements"));
    } finally {
      cleanup();
    }
  });
});
