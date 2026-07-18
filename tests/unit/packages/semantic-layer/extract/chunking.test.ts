import { describe, expect, it } from "vitest";
import { chunkNote } from "../../../../../packages/semantic-layer/src/extract/chunking.js";
import { readVault } from "../../../../../packages/semantic-layer/src/vault.js";
import { createTempVault } from "../../../../helpers.js";

function noteMd(body: string, title = "Sample note", desc = "A sample note for chunking."): string {
  return `---\nid: sample\ntitle: ${title}\ndesc: ${desc}\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

function readNote(body: string, title?: string, desc?: string) {
  const tv = createTempVault({ "vault/sample.md": noteMd(body, title, desc) });
  try {
    const { notes } = readVault(tv.vaultDir);
    const note = notes.get("sample");
    if (!note) throw new Error("expected sample note");
    return note;
  } finally {
    tv.cleanup();
  }
}

describe("chunkNote", () => {
  it("produces a single preamble chunk for a note with no headings", () => {
    const note = readNote("Just prose, no headings here.\n");
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      id: "sample",
      noteId: "sample",
      chunkIndex: 0,
      headingPath: "",
    });
    expect(chunks[0]?.text).toContain("Sample note");
    expect(chunks[0]?.text).toContain("A sample note for chunking.");
    expect(chunks[0]?.text).toContain("Just prose, no headings here.");
  });

  it("prefixes the preamble chunk with title and desc so short notes stay searchable", () => {
    const note = readNote("## First section\n\nBody text.\n", "Runtime contract", "Runtime facts.");
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });

    const preamble = chunks.find((chunk) => chunk.headingPath === "");
    expect(preamble?.text).toBe("Runtime contract\nRuntime facts.");
  });

  it("creates one chunk per heading section, keyed by heading slug", () => {
    const note = readNote(
      "Intro text.\n\n## First section\n\nFirst body.\n\n## Second section\n\nSecond body.\n",
    );
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });

    expect(chunks.map((chunk) => chunk.id)).toEqual([
      "sample",
      "sample#first-section",
      "sample#second-section",
    ]);
    expect(chunks[1]?.headingPath).toBe("First section");
    expect(chunks[1]?.text).toContain("First body.");
    expect(chunks[2]?.headingPath).toBe("Second section");
    expect(chunks[2]?.text).toContain("Second body.");
  });

  it("builds a breadcrumb headingPath for nested headings and resets on same-level siblings", () => {
    const note = readNote(
      [
        "## Parent",
        "",
        "Parent body.",
        "",
        "### Child",
        "",
        "Child body.",
        "",
        "## Sibling",
        "",
        "Sibling body.",
        "",
      ].join("\n"),
    );
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });

    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      "",
      "Parent",
      "Parent > Child",
      "Sibling",
    ]);
  });

  it("gives repeated heading text under different parents distinct, non-colliding ids", () => {
    const note = readNote(
      [
        "## Version 2.0",
        "",
        "### Fixed",
        "",
        "Fixed a v2 bug.",
        "",
        "## Version 1.0",
        "",
        "### Fixed",
        "",
        "Fixed a v1 bug.",
        "",
      ].join("\n"),
    );
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });

    const ids = chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("sample#version-20/fixed");
    expect(ids).toContain("sample#version-10/fixed");
  });

  it("assigns sequential chunkIndex values across all sections", () => {
    const note = readNote("## A\n\nBody A.\n\n## B\n\nBody B.\n");
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 2000 });
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
  });

  it("splits an oversized section into char-budget parts with suffixed ids", () => {
    const paragraph1 = "alpha ".repeat(20).trim();
    const paragraph2 = "beta ".repeat(20).trim();
    const note = readNote(`## Big section\n\n${paragraph1}\n\n${paragraph2}\n`);
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: paragraph1.length + 5 });

    const sectionChunks = chunks.filter((chunk) => chunk.headingPath === "Big section");
    expect(sectionChunks.map((chunk) => chunk.id)).toEqual([
      "sample#big-section#part-1",
      "sample#big-section#part-2",
    ]);
    expect(sectionChunks[0]?.text).toBe(`Big section\n\n${paragraph1}`);
    expect(sectionChunks[1]?.text).toBe(paragraph2);
  });

  it("hard-slices a single paragraph that alone exceeds the char budget", () => {
    const longWord = "x".repeat(50);
    const note = readNote(`## Section\n\n${longWord}\n`);
    const chunks = chunkNote(note, { strategy: "heading", maxChunkChars: 10 });

    const sectionChunks = chunks.filter((chunk) => chunk.headingPath === "Section");
    expect(sectionChunks.map((chunk) => chunk.id)).toEqual([
      "sample#section#part-1",
      "sample#section#part-2",
      "sample#section#part-3",
      "sample#section#part-4",
      "sample#section#part-5",
    ]);
    expect(sectionChunks[0]?.text).toBe(`Section\n\n${longWord.slice(0, 10)}`);
    expect(
      sectionChunks
        .slice(1)
        .map((chunk) => chunk.text)
        .join(""),
    ).toBe(longWord.slice(10));
  });

  it("produces a single whole-note chunk under the whole-note strategy", () => {
    const note = readNote("## First\n\nFirst body.\n\n## Second\n\nSecond body.\n");
    const chunks = chunkNote(note, { strategy: "whole-note", maxChunkChars: 5000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.id).toBe("sample");
    expect(chunks[0]?.headingPath).toBe("");
    expect(chunks[0]?.text).toContain("First body.");
    expect(chunks[0]?.text).toContain("Second body.");
  });

  it("char-budget splits an oversized whole-note chunk", () => {
    const body = "word ".repeat(50).trim();
    const note = readNote(body);
    const chunks = chunkNote(note, { strategy: "whole-note", maxChunkChars: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.id)).toEqual(chunks.map((_, i) => `sample#part-${i + 1}`));
  });
});
