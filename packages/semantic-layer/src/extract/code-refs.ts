import { collectCodeRefRequestsFromNotes, resolveCodeRefs } from "../code-refs.js";
import type { Note } from "../types.js";

export type CodeRefEdge = {
  noteId: string;
  symbolId: string;
  file: string;
  symbol: string;
  kind: string;
};

export async function extractCodeRefEdges(
  notes: Map<string, Note>,
  repoRoot: string,
): Promise<{ edges: CodeRefEdge[]; errors: string[] }> {
  const validNotes = new Set(notes.keys());
  const collected = collectCodeRefRequestsFromNotes(notes, validNotes);
  const resolved = resolveCodeRefs(collected.requests, repoRoot);

  const edges: CodeRefEdge[] = resolved.resolved.map((ref) => ({
    noteId: ref.note_id,
    symbolId: `${ref.ref.file}:${ref.ref.symbol}`,
    file: ref.ref.file,
    symbol: ref.ref.symbol,
    kind: ref.kind,
  }));

  const errors = [...collected.errors, ...resolved.errors].map((error) => error.message);

  return { edges, errors };
}
