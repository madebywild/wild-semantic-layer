import { slug } from "../vault.js";
import type { Note } from "../types.js";

export type WikilinkEdge = {
  source: string;
  target: string;
  anchor?: string;
  raw: string;
};

export function extractWikilinks(note: Note): WikilinkEdge[] {
  const edges: WikilinkEdge[] = [];

  const scannable = note.body
    .replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));

  for (const match of scannable.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const raw = match[1] ?? "";
    let target = raw.includes("|") ? (raw.split("|").at(1) ?? "") : raw;
    let anchor: string | undefined;
    if (target.includes("#")) {
      const [id, hash] = target.split("#");
      target = id ?? "";
      anchor = slug(hash ?? "");
    }
    target = target.trim();
    if (!target) continue;

    edges.push({
      source: note.id,
      target,
      ...(anchor ? { anchor } : {}),
      raw,
    });
  }

  return edges;
}
