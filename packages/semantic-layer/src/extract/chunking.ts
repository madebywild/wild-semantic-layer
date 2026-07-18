import type { Note, ResolvedSearchConfig } from "../types.js";

export type ChunkingOptions = ResolvedSearchConfig["chunking"];

/** One embeddable slice of a note: a whole note, a heading section, or a char-budget split of either. */
export type Chunk = {
  id: string;
  noteId: string;
  chunkIndex: number;
  headingPath: string;
  text: string;
};

type Section = {
  headingPath: string;
  headingSlug?: string;
  /** Context prepended to the section's first chunk: note title/desc, or the heading breadcrumb. */
  prefix: string;
  /** Section content with any heading markdown line already stripped. */
  body: string;
};

/** Splits a note into embeddable chunks per the configured strategy. Pure — no I/O. */
export function chunkNote(note: Note, options: ChunkingOptions): Chunk[] {
  const sections =
    options.strategy === "whole-note" ? wholeNoteSections(note) : headingSections(note);
  return toChunks(note.id, sections, options.maxChunkChars);
}

function wholeNoteSections(note: Note): Section[] {
  return [{ headingPath: "", prefix: notePrefix(note), body: note.body.trim() }];
}

/**
 * One preamble section for pre-heading content (always present, prefixed with title/desc so a
 * note is searchable even if every heading section is later trimmed away), then one section per
 * heading span. `headingPath`/`prefix` is a breadcrumb built from the heading's ancestor stack.
 */
function headingSections(note: Note): Section[] {
  const spans = note.headingSpans;
  const firstOffset = spans[0]?.offset ?? note.body.length;
  const sections: Section[] = [
    { headingPath: "", prefix: notePrefix(note), body: note.body.slice(0, firstOffset).trim() },
  ];

  const stack: Array<{ text: string; slug: string; level: number }> = [];
  for (const [index, heading] of spans.entries()) {
    const nextOffset = spans[index + 1]?.offset ?? note.body.length;
    const lineEnd = note.body.indexOf("\n", heading.offset);
    const bodyStart = lineEnd === -1 ? note.body.length : lineEnd + 1;

    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    stack.push({ text: heading.text, slug: heading.slug, level: heading.level });

    sections.push({
      headingPath: stack.map((entry) => entry.text).join(" > "),
      // The full ancestor path, not just the leaf slug: two headings with the same text under
      // different parents (e.g. a changelog's repeated "### Fixed" per version) must not collide.
      headingSlug: stack.map((entry) => entry.slug).join("/"),
      prefix: stack.map((entry) => entry.text).join(" > "),
      body: note.body.slice(bodyStart, nextOffset).trim(),
    });
  }
  return sections;
}

function notePrefix(note: Note): string {
  return `${note.fm.title}\n${note.fm.desc}`.trim();
}

/**
 * Splits each section's body on the char budget and prepends its prefix to only the first
 * resulting piece — reserving budget for the prefix on every piece would shrink the effective
 * body budget for tightly-configured chunk sizes and fragment content far more than necessary.
 */
function toChunks(noteId: string, sections: Section[], maxChunkChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  const usedIds = new Set<string>();
  for (const section of sections) {
    const bodyPieces = splitByBudget(section.body, maxChunkChars);
    const pieces = bodyPieces.length > 0 ? bodyPieces : section.prefix ? [""] : [];
    const baseId = section.headingSlug ? `${noteId}#${section.headingSlug}` : noteId;

    for (const [partIndex, bodyPiece] of pieces.entries()) {
      const text =
        partIndex === 0 ? [section.prefix, bodyPiece].filter(Boolean).join("\n\n") : bodyPiece;
      const id = uniqueId(pieces.length > 1 ? `${baseId}#part-${partIndex + 1}` : baseId, usedIds);
      chunks.push({
        id,
        noteId,
        chunkIndex: chunks.length,
        headingPath: section.headingPath,
        text,
      });
    }
  }
  return chunks;
}

/** Guarantees id uniqueness even if two sections still land on the same id (e.g. identical breadcrumbs). */
function uniqueId(candidate: string, used: Set<string>): string {
  let id = candidate;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${candidate}~${suffix}`;
  used.add(id);
  return id;
}

/**
 * Packs text into pieces no longer than `maxChars`. Splits on blank lines first, falling back to a
 * hard character slice for any single paragraph that alone exceeds the budget (e.g. a long code
 * block with no blank lines).
 */
function splitByBudget(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).flatMap((paragraph) => hardSlice(paragraph, maxChars));
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && candidate.length > maxChars) {
      pieces.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function hardSlice(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const slices: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    slices.push(text.slice(offset, offset + maxChars));
  }
  return slices;
}
