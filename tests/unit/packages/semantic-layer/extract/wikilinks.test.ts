import { describe, expect, it } from "vitest";
import { extractWikilinks } from "../../../../../packages/semantic-layer/src/extract/wikilinks.js";
import type { Note } from "../../../../../packages/semantic-layer/src/types.js";

function makeNote(id: string, body: string): Note {
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
    body,
    headings: new Set(),
    headingSpans: [],
  };
}

describe("extractWikilinks", () => {
  it("extracts a basic wikilink", () => {
    const note = makeNote("root", "See [[runtime]] for details.");
    expect(extractWikilinks(note)).toEqual([{ source: "root", target: "runtime", raw: "runtime" }]);
  });

  it("extracts aliased wikilinks", () => {
    const note = makeNote("root", "Check [[the runtime note|runtime]] out.");
    expect(extractWikilinks(note)).toEqual([
      { source: "root", target: "runtime", raw: "the runtime note|runtime" },
    ]);
  });

  it("extracts heading anchors", () => {
    const note = makeNote("root", "See [[runtime#UI Layer]].");
    expect(extractWikilinks(note)).toEqual([
      { source: "root", target: "runtime", anchor: "ui-layer", raw: "runtime#UI Layer" },
    ]);
  });

  it("extracts multiple wikilinks", () => {
    const note = makeNote("root", "[[foo]] and [[bar|baz]].");
    expect(extractWikilinks(note)).toEqual([
      { source: "root", target: "foo", raw: "foo" },
      { source: "root", target: "baz", raw: "bar|baz" },
    ]);
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const note = makeNote("root", "```\n[[hidden]]\n```\n[[visible]]");
    expect(extractWikilinks(note)).toEqual([{ source: "root", target: "visible", raw: "visible" }]);
  });

  it("ignores wikilinks inside inline code", () => {
    const note = makeNote("root", "`[[inline]]` and [[real]]");
    expect(extractWikilinks(note)).toEqual([{ source: "root", target: "real", raw: "real" }]);
  });

  it("does not validate that the target exists", () => {
    const note = makeNote("root", "[[missing]]");
    expect(extractWikilinks(note)).toEqual([{ source: "root", target: "missing", raw: "missing" }]);
  });
});
