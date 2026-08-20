import type { Note, ResolvedWikilinkConfig } from "../types.js";

export type WikilinkEdge = {
  source: string;
  target: string;
  /** Canonical heading path using the note's exact heading text, for example `Parent#Child`. */
  anchor?: string;
  raw: string;
};

export type WikilinkExtractionResult = {
  edges: WikilinkEdge[];
  errors: string[];
};

type ParsedWikilink = {
  target: string;
  headingSegments: string[];
};

type HeadingPath = {
  keys: string[];
  texts: string[];
};

/**
 * Extracts and validates every wikilink in a vault with one shared parser.
 *
 * Both `check` and `index` consume this result, so syntax, target resolution, heading resolution,
 * code-block masking, and edge deduplication cannot drift between the two commands.
 */
export function extractVaultWikilinks(
  notes: Map<string, Note>,
  config: ResolvedWikilinkConfig,
): WikilinkExtractionResult {
  const edges: WikilinkEdge[] = [];
  const errors: string[] = [];
  const seenEdges = new Set<string>();

  for (const note of notes.values()) {
    const extracted = extractWikilinks(note, notes, config);
    errors.push(...extracted.errors);
    for (const edge of extracted.edges) {
      const key = `${edge.source}\0${edge.target}\0${edge.anchor ?? ""}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(edge);
    }
  }

  return { edges, errors };
}

/** Extracts and validates the wikilinks from one note against the complete vault. */
export function extractWikilinks(
  note: Note,
  notes: Map<string, Note>,
  config: ResolvedWikilinkConfig,
): WikilinkExtractionResult {
  const edges: WikilinkEdge[] = [];
  const errors: string[] = [];

  const scannable = maskCode(note.body);

  for (const match of scannable.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const raw = match[1] ?? "";
    const parsed = parseWikilink(raw, note.id, config);
    if (typeof parsed === "string") {
      errors.push(formatError(note.id, raw, parsed));
      continue;
    }

    const linked = notes.get(parsed.target);
    if (!linked) {
      errors.push(formatError(note.id, raw, `points at unknown note "${parsed.target}"`));
      continue;
    }

    let anchor: string | undefined;
    if (parsed.headingSegments.length > 0) {
      const paths = headingPaths(linked);
      const matches = resolveHeadingPath(paths, parsed.headingSegments);
      if (matches.length === 0) {
        errors.push(
          formatError(note.id, raw, `points at a missing heading in ${parsed.target}.md`),
        );
        continue;
      }
      if (matches.length > 1) {
        errors.push(
          formatError(
            note.id,
            raw,
            `points at an ambiguous heading in ${parsed.target}.md; use its full #Parent#Child path`,
          ),
        );
        continue;
      }
      const matched = matches[0];
      if (matched) anchor = shortestUniqueHeadingPath(paths, matched).join("#");
    }

    edges.push({
      source: note.id,
      target: parsed.target,
      ...(anchor ? { anchor } : {}),
      raw,
    });
  }

  return { edges, errors };
}

function parseWikilink(
  raw: string,
  sourceId: string,
  config: ResolvedWikilinkConfig,
): ParsedWikilink | string {
  const pipeParts = raw.split("|");
  if (pipeParts.length > 2) return "contains more than one pipe";

  const hasAlias = pipeParts.length === 2;
  const destinationPart =
    hasAlias && config.aliasOrder === "dendron" ? (pipeParts[1] ?? "") : (pipeParts[0] ?? "");
  const aliasPart =
    hasAlias && config.aliasOrder === "dendron" ? (pipeParts[0] ?? "") : (pipeParts[1] ?? "");
  if (hasAlias && !aliasPart.trim()) return "has an empty alias";

  const [targetPart = "", ...headingParts] = destinationPart.split("#");
  const headingSegments = headingParts.map((part) => part.trim());
  if (headingSegments.some((segment) => !segment)) return "has an empty heading segment";

  const explicitTarget = targetPart.trim();
  if (!explicitTarget && headingSegments.length === 0) return "has an empty note target";

  return {
    target: explicitTarget || sourceId,
    headingSegments,
  };
}

function resolveHeadingPath(paths: HeadingPath[], requestedSegments: string[]): HeadingPath[] {
  const requestedKeys = requestedSegments.map(headingKey);
  return paths.filter((candidate) => endsWith(candidate.keys, requestedKeys));
}

function headingPaths(note: Note): HeadingPath[] {
  const paths: HeadingPath[] = [];
  const stack: Array<{ key: string; text: string; level: number }> = [];
  for (const heading of note.headingSpans) {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    stack.push({ key: headingKey(heading.text), text: heading.text.trim(), level: heading.level });
    paths.push({
      keys: stack.map((entry) => entry.key),
      texts: stack.map((entry) => entry.text),
    });
  }
  return paths;
}

function shortestUniqueHeadingPath(paths: HeadingPath[], selected: HeadingPath): string[] {
  for (let length = 1; length <= selected.keys.length; length += 1) {
    const keys = selected.keys.slice(-length);
    if (paths.filter((candidate) => endsWith(candidate.keys, keys)).length === 1) {
      return selected.texts.slice(-length);
    }
  }
  return selected.texts;
}

function headingKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function endsWith(values: string[], suffix: string[]): boolean {
  if (suffix.length > values.length) return false;
  const offset = values.length - suffix.length;
  return suffix.every((value, index) => values[offset + index] === value);
}

function maskCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));
}

function formatError(noteId: string, raw: string, detail: string): string {
  return `[${noteId}] wikilink "[[${raw}]]" ${detail}`;
}
