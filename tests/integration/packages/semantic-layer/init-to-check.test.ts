import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck, runIndex, runInit } from "../../../../packages/semantic-layer/src/index.js";
import { createTempDir } from "../../../helpers.js";

describe("init → check pipeline (integration)", () => {
  it("init then check passes", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      const result = runCheck({ cwd: dir });
      expect(result.errors).toHaveLength(0);
      expect(result.noteCount).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("init then check with custom vault name", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir, vault: "docs" });
      const result = runCheck({ cwd: dir });
      expect(result.errors).toHaveLength(0);
      expect(result.noteCount).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("init then check fails after breaking a note", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      // Break root.md by removing the title field
      const rootPath = join(dir, "vault", "root.md");
      const content = readFileSync(rootPath, "utf8");
      writeFileSync(rootPath, content.replace("title: Docs root", "title: ''"));
      const result = runCheck({ cwd: dir });
      expect(result.errors.some((e) => e.includes("frontmatter"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("init then index then check passes", () => {
    const { dir, cleanup } = createTempDir();
    try {
      runInit({ cwd: dir });
      // Run index to generate HIERARCHY.md
      runIndex({ cwd: dir });
      // Check should still pass (HIERARCHY.md should be ignored)
      const result = runCheck({ cwd: dir });
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
