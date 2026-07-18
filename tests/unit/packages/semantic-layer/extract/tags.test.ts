import { describe, expect, it } from "vitest";
import { extractTagEdges } from "../../../../../packages/semantic-layer/src/extract/tags.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";

function makeNote(id: string, tags?: unknown): Note {
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
      ...(tags !== undefined ? { tags: tags as string[] } : {}),
    },
    body: "",
    headings: new Set(),
    headingSpans: [],
  };
}

describe("extractTagEdges", () => {
  it("creates one edge per tag", () => {
    const notes = new Map<string, Note>([
      ["a", makeNote("a", ["foo", "bar"])],
      ["b", makeNote("b", ["baz"])],
    ]);

    expect(extractTagEdges(notes)).toEqual([
      { noteId: "a", tag: "foo" },
      { noteId: "a", tag: "bar" },
      { noteId: "b", tag: "baz" },
    ]);
  });

  it("ignores notes without tags", () => {
    const notes = new Map<string, Note>([
      ["a", makeNote("a")],
      ["b", makeNote("b", ["foo"])],
    ]);

    expect(extractTagEdges(notes)).toEqual([{ noteId: "b", tag: "foo" }]);
  });

  it("skips non-string tag entries", () => {
    const note = makeNote("a", ["foo", 123, null, "bar"]);
    const notes = new Map<string, Note>([["a", note]]);

    expect(extractTagEdges(notes)).toEqual([
      { noteId: "a", tag: "foo" },
      { noteId: "a", tag: "bar" },
    ]);
  });
});
