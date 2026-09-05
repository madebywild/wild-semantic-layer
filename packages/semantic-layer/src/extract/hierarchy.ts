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

/**
 * Ancestor notes that a dotted id needs but the vault does not hold, reported in the same words by
 * `check` and by `index`. A hierarchy edge joins two real notes, so a vault with a missing ancestor
 * must be rejected while it is still a vault problem: writing its edges fails on the foreign key
 * instead, and a raw `FOREIGN KEY constraint failed` names neither the note nor the missing parent.
 */
export function validateHierarchyAncestors(notes: Map<string, { id: string }>): string[] {
  const errors: string[] = [];
  for (const id of notes.keys()) {
    const parts = id.split(".");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join(".");
      if (!notes.has(ancestor)) {
        errors.push(`[${id}] missing ancestor "${ancestor}.md" in the hierarchy`);
      }
    }
  }
  return errors;
}
