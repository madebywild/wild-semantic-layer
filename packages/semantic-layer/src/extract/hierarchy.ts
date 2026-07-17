import type { Note } from "../types.js";

export type HierarchyEdge = {
  parent: string;
  child: string;
};

export function extractHierarchyEdges(notes: Map<string, Note>): HierarchyEdge[] {
  const seen = new Set<string>();
  const edges: HierarchyEdge[] = [];

  for (const note of notes.values()) {
    const parts = note.id.split(".");
    if (parts.length < 2) continue;

    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join(".");
      const child = parts.slice(0, i + 1).join(".");
      const key = `${parent}\n${child}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ parent, child });
    }
  }

  return edges;
}
