import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexResolved } from "../../../../packages/semantic-layer/src/commands/index.js";
import { loadConfig } from "../../../../packages/semantic-layer/src/config.js";
import { withConnectionForConfig } from "../../../../packages/semantic-layer/src/db/connection.js";
import { runIndex } from "../../../../packages/semantic-layer/src/index.js";
import { createFakeEmbedder, createTempVault } from "../../../helpers.js";

function validNoteMd(
  id: string,
  title = id,
  desc = "Test note.",
  status = "active",
  body = "",
): string {
  return `---\nid: ${id}\ntitle: ${title}\ndesc: ${desc}\nstatus: ${status}\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

describe("index generation (integration)", () => {
  it("generates correct hierarchy for a demo-style vault", async () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root", "Root", "Entry point."),
      "vault/meta.md": validNoteMd("meta", "Metadata", "Operating notes."),
      "vault/meta.agent-conventions.md": validNoteMd(
        "meta.agent-conventions",
        "Agent conventions",
        "How agents read this.",
      ),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [meta]\n",
      "vault/meta.schema.yml":
        "version: 1\nschemas:\n  - id: meta\n    parent: root\n    children: [agent-conventions]\n",
    });

    try {
      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      const content = readFileSync(result.outFile, "utf8");

      expect(content).toContain("**root**");
      expect(content).toContain("**meta**");
      expect(content).toContain("**meta.agent-conventions**");

      // Root should come first
      const lines = content.split("\n");
      const rootIdx = lines.findIndex((l) => l.includes("**root**"));
      const metaIdx = lines.findIndex(
        (l) => l.includes("**meta**") && !l.includes("meta.agent-conventions"),
      );
      expect(rootIdx).toBeLessThan(metaIdx);
    } finally {
      tv.cleanup();
    }
  });

  it("updates existing HIERARCHY.md on second run", async () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });

    try {
      const config = loadConfig({ cwd: tv.dir });
      const embedder = createFakeEmbedder();

      // Reuse a single LadybugDB connection across both runs to avoid the WAL checkpoint race that
      // intermittently corrupts rapid open/close cycles in the same process.
      await withConnectionForConfig(config, async (conn) => {
        const result1 = await indexResolved(config, { embedder, connection: conn });

        // Add a note and re-run
        writeFileSync(join(tv.vaultDir, "alpha.md"), validNoteMd("alpha"));
        writeFileSync(
          join(tv.vaultDir, "root.schema.yml"),
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
        );

        const result2 = await indexResolved(config, { embedder, connection: conn });
        const content2 = readFileSync(result2.outFile, "utf8");

        expect(result2.noteCount).toBeGreaterThan(result1.noteCount);
        expect(content2).toContain("**alpha**");
      });
    } finally {
      tv.cleanup();
    }
  });

  it("handles empty vault (root only)", async () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });

    try {
      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      expect(result.noteCount).toBe(1);
      const content = readFileSync(result.outFile, "utf8");
      expect(content).toContain("**root**");
    } finally {
      tv.cleanup();
    }
  });

  it("handles deeply nested notes", async () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root"),
      "vault/a.md": validNoteMd("a"),
      "vault/a.b.md": validNoteMd("a.b"),
      "vault/a.b.c.md": validNoteMd("a.b.c"),
      "vault/a.b.c.d.md": validNoteMd("a.b.c.d"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [a]\n",
      "vault/a.schema.yml":
        "version: 1\nschemas:\n  - id: a\n    parent: root\n    namespace: true\n    children: []\n",
    });

    try {
      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      const content = readFileSync(result.outFile, "utf8");
      const lines = content.split("\n");

      const dLine = lines.find((l) => l.includes("**a.b.c.d**"));
      expect(dLine).toBeDefined();
      // Depth 3 should have 6 spaces of indentation
      expect(dLine?.startsWith("      -")).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("generates code refs sidecar for notes with resolved symbols", async () => {
    const tv = createTempVault({
      "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Entry point.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\ncode_refs:\n  - file: src/service.js\n    symbol: issueToken\n    kind: function\n---\n\nRoot.`,
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      "src/service.js": "export function issueToken() {\n  return 'token';\n}\n",
    });

    try {
      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      const sidecar = JSON.parse(readFileSync(result.codeRefsFile, "utf8")) as {
        refs: Array<{ note_id: string; kind: string; line: number; column: number }>;
      };
      expect(sidecar.refs).toEqual([
        expect.objectContaining({
          note_id: "root",
          kind: "function",
          line: 1,
          column: 17,
        }),
      ]);
    } finally {
      tv.cleanup();
    }
  });
});
