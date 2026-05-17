import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../../../packages/semantic-layer/src/init.js";
import { createTempDir } from "../../../helpers.js";

describe("runInit", () => {
  it("creates vault directory", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(existsSync(join(dir, "vault"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("creates semantic-layer.config.yml", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      const configPath = join(dir, "semantic-layer.config.yml");
      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain("vault:");
      expect(content).toContain("root:");
      expect(content).toContain("evolution:");
      expect(content).toContain("stagingDir: vault/.semantic-layer/refinements");
    } finally {
      cleanup();
    }
  });

  it("creates root.md", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      const rootPath = join(dir, "vault", "root.md");
      expect(existsSync(rootPath)).toBe(true);
      const content = readFileSync(rootPath, "utf8");
      expect(content).toContain("id: root");
      expect(content).toContain("title:");
      expect(content).toContain("status:");
    } finally {
      cleanup();
    }
  });

  it("creates meta.md", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(existsSync(join(dir, "vault", "meta.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("creates meta.agent-conventions.md", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(existsSync(join(dir, "vault", "meta.agent-conventions.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("creates root.schema.yml", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(existsSync(join(dir, "vault", "root.schema.yml"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("creates meta.schema.yml", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(existsSync(join(dir, "vault", "meta.schema.yml"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not create domain or architecture sample notes", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      const files = readdirSync(join(dir, "vault")).sort();
      expect(files).toEqual([
        "meta.agent-conventions.md",
        "meta.md",
        "meta.schema.yml",
        "root.md",
        "root.schema.yml",
      ]);
      expect(files.some((file) => /^(auth|infra|payments)(\.|$)/.test(file))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses to overwrite existing files", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      expect(() => runInit({ cwd: dir })).toThrow("refusing to overwrite");
    } finally {
      cleanup();
    }
  });

  it("uses custom vault name", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const result = runInit({ cwd: dir, vault: "docs" });
      expect(existsSync(join(dir, "docs"))).toBe(true);
      expect(existsSync(join(dir, "docs", "root.md"))).toBe(true);
      expect(result.vaultDir).toContain("docs");
      expect(readFileSync(join(dir, "semantic-layer.config.yml"), "utf8")).toContain(
        "vault: docs\n",
      );
      expect(readFileSync(join(dir, "semantic-layer.config.yml"), "utf8")).toContain(
        "stagingDir: docs/.semantic-layer/refinements",
      );
    } finally {
      cleanup();
    }
  });

  it("uses custom owner", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir, owner: "custom@example.com" });
      const content = readFileSync(join(dir, "vault", "root.md"), "utf8");
      expect(content).toContain("owner: custom@example.com");
    } finally {
      cleanup();
    }
  });

  it("uses today's date for last_verified", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      const content = readFileSync(join(dir, "vault", "root.md"), "utf8");
      const today = new Date().toISOString().slice(0, 10);
      expect(content).toContain(`last_verified: ${today}`);
    } finally {
      cleanup();
    }
  });

  it("returns vaultDir", () => {
    const { dir, cleanup } = createTempDir();
    try {
      const result = runInit({ cwd: dir });
      expect(result.vaultDir).toBe(join(dir, "vault"));
    } finally {
      cleanup();
    }
  });
});
