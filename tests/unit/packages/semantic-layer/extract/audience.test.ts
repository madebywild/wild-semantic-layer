import { describe, expect, it } from "vitest";
import { extractAudienceEdges } from "../../../../../packages/semantic-layer/src/extract/audience.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";

function makeNote(id: string, audience?: unknown): Note {
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
      ...(audience !== undefined ? { audience: audience as string[] } : {}),
    },
    body: "",
    headings: new Set(),
    headingSpans: [],
  };
}

describe("extractAudienceEdges", () => {
  it("creates one edge per audience value", () => {
    const notes = new Map<string, Note>([
      ["a", makeNote("a", ["backend", "devops"])],
      ["b", makeNote("b", ["frontend"])],
    ]);

    expect(extractAudienceEdges(notes)).toEqual([
      { noteId: "a", audience: "backend" },
      { noteId: "a", audience: "devops" },
      { noteId: "b", audience: "frontend" },
    ]);
  });

  it("ignores notes without audience", () => {
    const notes = new Map<string, Note>([
      ["a", makeNote("a")],
      ["b", makeNote("b", ["frontend"])],
    ]);

    expect(extractAudienceEdges(notes)).toEqual([{ noteId: "b", audience: "frontend" }]);
  });

  it("skips non-string audience entries", () => {
    const note = makeNote("a", ["backend", true, "frontend"]);
    const notes = new Map<string, Note>([["a", note]]);

    expect(extractAudienceEdges(notes)).toEqual([
      { noteId: "a", audience: "backend" },
      { noteId: "a", audience: "frontend" },
    ]);
  });
});
