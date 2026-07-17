import type { Note } from "../types.js";

export type AudienceEdge = {
  noteId: string;
  audience: string;
};

export function extractAudienceEdges(notes: Map<string, Note>): AudienceEdge[] {
  const edges: AudienceEdge[] = [];

  for (const note of notes.values()) {
    const audience = note.fm.audience;
    if (!Array.isArray(audience)) continue;
    for (const entry of audience) {
      if (typeof entry !== "string") continue;
      edges.push({ noteId: note.id, audience: entry });
    }
  }

  return edges;
}
