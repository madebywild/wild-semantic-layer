import { describe, expect, it } from "vitest";
import {
  extractVaultWikilinks,
  extractWikilinks,
} from "../../../../../packages/semantic-layer/src/extract/wikilinks.js";
import type {
  Note,
  ResolvedWikilinkConfig,
} from "../../../../../packages/semantic-layer/src/types.js";
import { slug } from "../../../../../packages/semantic-layer/src/vault.js";

const DENDRON: ResolvedWikilinkConfig = { aliasOrder: "dendron" };
const OBSIDIAN: ResolvedWikilinkConfig = { aliasOrder: "obsidian" };

function makeNote(id: string, body: string): Note {
  const headingSpans = [...body.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
    text: match[2] ?? "",
    slug: slug(match[2] ?? ""),
    level: (match[1] ?? "").length,
    offset: match.index ?? 0,
  }));
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
    headings: new Set(headingSpans.map((heading) => heading.slug)),
    headingSpans,
  };
}

function extract(note: Note, linked: Note[] = [], config: ResolvedWikilinkConfig = DENDRON) {
  return extractWikilinks(
    note,
    new Map([note, ...linked].map((candidate) => [candidate.id, candidate])),
    config,
  );
}

describe("extractWikilinks", () => {
  it("extracts a basic wikilink", () => {
    const note = makeNote("root", "See [[runtime]] for details.");
    expect(extract(note, [makeNote("runtime", "")])).toEqual({
      edges: [{ source: "root", target: "runtime", raw: "runtime" }],
      errors: [],
    });
  });

  it("uses Dendron alias-before-target order by default", () => {
    const note = makeNote("root", "Check [[the runtime note|runtime]] out.");
    expect(extract(note, [makeNote("runtime", "")]).edges).toEqual([
      { source: "root", target: "runtime", raw: "the runtime note|runtime" },
    ]);
  });

  it("supports Obsidian target-before-alias order when configured", () => {
    const note = makeNote("root", "Check [[runtime|the runtime note]] out.");
    expect(extract(note, [makeNote("runtime", "")], OBSIDIAN).edges).toEqual([
      { source: "root", target: "runtime", raw: "runtime|the runtime note" },
    ]);
  });

  it("extracts heading anchors", () => {
    const note = makeNote("root", "See [[runtime#UI Layer]].");
    const runtime = makeNote("runtime", "## UI Layer\n");
    expect(extract(note, [runtime]).edges).toEqual([
      { source: "root", target: "runtime", anchor: "UI Layer", raw: "runtime#UI Layer" },
    ]);
  });

  it("resolves anchor-only links against their source note", () => {
    const note = makeNote("root", "## Local heading\n\nSee [[#Local heading]].");
    expect(extract(note)).toEqual({
      edges: [{ source: "root", target: "root", anchor: "Local heading", raw: "#Local heading" }],
      errors: [],
    });
  });

  it("resolves every segment of a nested heading path", () => {
    const note = makeNote("root", "See [[runtime#Parent#Child]].");
    const runtime = makeNote("runtime", "## Parent\n\n### Child\n\n## Other parent\n\n### Child\n");
    expect(extract(note, [runtime]).edges).toEqual([
      {
        source: "root",
        target: "runtime",
        anchor: "Parent#Child",
        raw: "runtime#Parent#Child",
      },
    ]);
  });

  it("extracts multiple wikilinks", () => {
    const note = makeNote("root", "[[foo]] and [[bar|baz]].");
    expect(extract(note, [makeNote("foo", ""), makeNote("baz", "")]).edges).toEqual([
      { source: "root", target: "foo", raw: "foo" },
      { source: "root", target: "baz", raw: "bar|baz" },
    ]);
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const note = makeNote("root", "```\n[[hidden]]\n```\n[[visible]]");
    expect(extract(note, [makeNote("visible", "")]).edges).toEqual([
      { source: "root", target: "visible", raw: "visible" },
    ]);
  });

  it("ignores wikilinks inside inline code", () => {
    const note = makeNote("root", "`[[inline]]` and [[real]]");
    expect(extract(note, [makeNote("real", "")]).edges).toEqual([
      { source: "root", target: "real", raw: "real" },
    ]);
  });

  it("reports unknown targets instead of emitting dangling edges", () => {
    const note = makeNote("root", "[[missing]]");
    expect(extract(note)).toEqual({
      edges: [],
      errors: ['[root] wikilink "[[missing]]" points at unknown note "missing"'],
    });
  });

  it("rejects multiple pipes and empty heading segments deterministically", () => {
    const note = makeNote("root", "[[a|b|c]] [[root#Parent##Child]]");
    expect(extract(note).errors).toEqual([
      '[root] wikilink "[[a|b|c]]" contains more than one pipe',
      '[root] wikilink "[[root#Parent##Child]]" has an empty heading segment',
    ]);
  });

  it("requires exact punctuation while matching headings case-insensitively", () => {
    const exact = makeNote("exact", "[[target#WHAT'S NEW?]]");
    const inexact = makeNote("inexact", "[[target#Whats new]]");
    const target = makeNote("target", "## What's new?\n");
    expect(extract(exact, [target]).errors).toEqual([]);
    expect(extract(exact, [target]).edges[0]?.anchor).toBe("What's new?");
    expect(extract(inexact, [target]).errors[0]).toContain("missing heading");
  });

  it("requires a full path when a leaf heading is ambiguous", () => {
    const ambiguous = makeNote("root", "[[target#Fixed]]");
    const qualified = makeNote("qualified", "[[target#Version 2#Fixed]]");
    const target = makeNote("target", "## Version 2\n\n### Fixed\n\n## Version 1\n\n### Fixed\n");
    expect(extract(ambiguous, [target]).errors[0]).toContain("ambiguous heading");
    expect(extract(qualified, [target]).edges[0]?.anchor).toBe("Version 2#Fixed");
  });

  it("preserves Unicode heading identity", () => {
    const note = makeNote("root", "[[target#Überblick]]");
    const target = makeNote("target", "## Überblick\n");
    expect(extract(note, [target]).edges[0]?.anchor).toBe("Überblick");
  });

  it("deduplicates repeated links before they reach the database", () => {
    const root = makeNote("root", "[[target]] and [[target]] again.");
    const target = makeNote("target", "");
    expect(
      extractVaultWikilinks(new Map([root, target].map((note) => [note.id, note])), DENDRON),
    ).toEqual({
      edges: [{ source: "root", target: "target", raw: "target" }],
      errors: [],
    });
  });
});
