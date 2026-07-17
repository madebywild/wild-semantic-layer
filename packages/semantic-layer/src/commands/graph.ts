import { loadConfig, type LoadConfigOptions } from "../config.js";
import {
  ancestors,
  backlinks,
  codeImpact,
  cycles,
  descendants,
  forwardLinks,
  orphans,
  relatedNotes,
} from "../db/queries/graph.js";
import type {
  AncestorResult,
  BacklinkResult,
  CodeImpactResult,
  CycleResult,
  DescendantResult,
  ForwardLinkResult,
  OrphanResult,
  RelatedNoteResult,
} from "../types.js";

export type GraphCommandResult =
  | { subcommand: "backlinks" | "links"; hits: BacklinkResult[] | ForwardLinkResult[] }
  | { subcommand: "descendants" | "ancestors"; hits: DescendantResult[] | AncestorResult[] }
  | { subcommand: "orphans"; hits: OrphanResult[] }
  | { subcommand: "related"; hits: RelatedNoteResult[] }
  | { subcommand: "impact"; hits: CodeImpactResult[] }
  | { subcommand: "cycles"; hits: CycleResult[] };

export type GraphCommandOptions = LoadConfigOptions & {
  subcommand: string;
  noteId?: string;
  file?: string;
  symbol?: string;
  limit?: number;
  depth?: number;
  json?: boolean;
};

/**
 * Dispatches a `semantic-layer graph <subcommand>` invocation to the matching
 * graph query. Returns structured hits; the CLI owns rendering (list or --json).
 */
export async function runGraph(options: GraphCommandOptions): Promise<GraphCommandResult> {
  const { subcommand, noteId, file, symbol, limit, depth, ...loadOptions } = options;
  const config = loadConfig(loadOptions);

  switch (subcommand) {
    case "backlinks":
      return {
        subcommand,
        hits: await backlinks(config, requireNoteId(noteId, subcommand), { limit }),
      };
    case "links":
      return {
        subcommand,
        hits: await forwardLinks(config, requireNoteId(noteId, subcommand), { limit }),
      };
    case "descendants":
      return {
        subcommand,
        hits: await descendants(config, requireNoteId(noteId, subcommand), { depth }),
      };
    case "ancestors":
      return {
        subcommand,
        hits: await ancestors(config, requireNoteId(noteId, subcommand), { depth }),
      };
    case "orphans":
      return { subcommand, hits: await orphans(config) };
    case "related":
      return {
        subcommand,
        hits: await relatedNotes(config, requireNoteId(noteId, subcommand), { limit }),
      };
    case "impact":
      if (!file && !symbol) {
        throw new Error("graph impact requires --file and/or --symbol");
      }
      return { subcommand, hits: await codeImpact(config, { file, symbol }) };
    case "cycles":
      return { subcommand, hits: await cycles(config, { limit }) };
    default:
      throw new Error(
        `Unknown graph subcommand: ${subcommand}. Use backlinks, links, descendants, ancestors, orphans, related, impact, or cycles.`,
      );
  }
}

function requireNoteId(noteId: string | undefined, subcommand: string): string {
  if (!noteId) throw new Error(`graph ${subcommand} requires a note id`);
  return noteId;
}
