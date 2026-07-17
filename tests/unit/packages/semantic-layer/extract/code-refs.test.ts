import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractCodeRefEdges } from "../../../../../packages/semantic-layer/src/extract/code-refs.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";
import { createTempDir } from "../../../../helpers.js";

function makeNote(id: string, codeRefs?: Note["fm"]["code_refs"]): Note {
  return {
    id,
    file: `${id}.md`,
    fm: {
      id,
      title: id,
      desc: `${id} description`,
      status: "active",
      owner: "tester@example.com",
      last_verified: "2026-07-16",
      ttl_days: 365,
      ...(codeRefs ? { code_refs: codeRefs } : {}),
    },
    body: "",
    headings: new Set(),
    headingSpans: [],
  };
}

describe("extractCodeRefEdges", () => {
  it("resolves code refs into edges", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const srcDir = join(dir, "src");
      mkdirSync(srcDir);
      writeFileSync(
        join(srcDir, "utils.ts"),
        "export const VERSION = 1;\nexport function greet() { return 'hi'; }\n",
      );

      const notes = new Map<string, Note>([
        [
          "runtime",
          makeNote("runtime", [
            { file: "src/utils.ts", symbol: "VERSION", kind: "const" },
            { file: "src/utils.ts", symbol: "greet", kind: "function" },
          ]),
        ],
      ]);

      const { edges, errors } = await extractCodeRefEdges(notes, dir);
      expect(errors).toEqual([]);
      expect(edges).toEqual([
        {
          noteId: "runtime",
          symbolId: "src/utils.ts:greet",
          file: "src/utils.ts",
          symbol: "greet",
          kind: "function",
        },
        {
          noteId: "runtime",
          symbolId: "src/utils.ts:VERSION",
          file: "src/utils.ts",
          symbol: "VERSION",
          kind: "const",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("reports errors for missing files", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const notes = new Map<string, Note>([
        ["runtime", makeNote("runtime", [{ file: "src/missing.ts", symbol: "foo" }])],
      ]);

      const { edges, errors } = await extractCodeRefEdges(notes, dir);
      expect(edges).toEqual([]);
      expect(errors).toEqual(["[runtime] code_ref file does not exist: src/missing.ts"]);
    } finally {
      cleanup();
    }
  });
});
