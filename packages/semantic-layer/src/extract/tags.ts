import type { Note } from "../types.js";

export type TagEdge = {
  noteId: string;
  tag: string;
};

export function extractTagEdges(notes: Map<string, Note>): TagEdge[] {
  const edges: TagEdge[] = [];

  for (const note of notes.values()) {
    const tags = note.fm.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== "string") continue;
      edges.push({ noteId: note.id, tag });
    }
  }

  return edges;
}
