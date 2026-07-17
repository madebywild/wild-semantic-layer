import { describe, expect, it } from "vitest";
import { extractHierarchyEdges } from "../../../../../packages/semantic-layer/src/extract/hierarchy.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";

function makeNote(id: string): Note {
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
    },
    body: "",
    headings: new Set(),
    headingSpans: [],
  };
}

describe("extractHierarchyEdges", () => {
  it("creates ancestor edges from dotted IDs", () => {
    const notes = new Map<string, Note>([
      ["demo", makeNote("demo")],
      ["demo.runtime", makeNote("demo.runtime")],
      ["demo.runtime.ui", makeNote("demo.runtime.ui")],
    ]);

    expect(extractHierarchyEdges(notes)).toEqual([
      { parent: "demo", child: "demo.runtime" },
      { parent: "demo.runtime", child: "demo.runtime.ui" },
    ]);
  });

  it("does not add root edges for top-level notes", () => {
    const notes = new Map<string, Note>([
      ["root", makeNote("root")],
      ["demo", makeNote("demo")],
    ]);

    expect(extractHierarchyEdges(notes)).toEqual([]);
  });

  it("handles multiple branches", () => {
    const notes = new Map<string, Note>([
      ["a.b", makeNote("a.b")],
      ["x.y.z", makeNote("x.y.z")],
    ]);

    expect(extractHierarchyEdges(notes)).toEqual([
      { parent: "a", child: "a.b" },
      { parent: "x", child: "x.y" },
      { parent: "x.y", child: "x.y.z" },
    ]);
  });
});
