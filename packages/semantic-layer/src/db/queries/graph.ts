import type { Connection } from "@ladybugdb/core";
import { existsSync } from "node:fs";
import { getHeadSha, isAncestorOfHead } from "../../search/git-diff.js";
import type {
  AncestorResult,
  BacklinkResult,
  CodeImpactResult,
  CycleResult,
  DescendantResult,
  ForwardLinkResult,
  OrphanResult,
  RelatedNoteResult,
  ResolvedConfig,
} from "../../types.js";
import { dbFileForConfig, withConnectionForConfig } from "../connection.js";
import { queryRows } from "../cypher.js";
import { configStalenessReasons, readIndexMeta } from "../meta.js";

/**
 * Read-only graph queries over the LadybugDB vault index built by `db/indexer.ts`.
 * Every function requires an existing index; a missing one throws and points at
 * `semantic-layer index`, and a stale one (schema version or vault moved, index
 * behind HEAD) warns on stderr but still runs.
 */

export async function backlinks(
  config: ResolvedConfig,
  noteId: string,
  options: { limit?: number } = {},
): Promise<BacklinkResult[]> {
  const limit = validateLimit(options.limit);
  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH (src:Note)-[r:LINKS_TO]->(dst:Note {id: $noteId})
       RETURN src.id AS sourceId, src.title AS sourceTitle, r.anchor AS anchor, src.status AS status
       ORDER BY src.id${limit ? " LIMIT $limit" : ""}`,
      { noteId, ...(limit ? { limit } : {}) },
    );
    return rows.map((row) => ({
      sourceId: String(row.sourceId),
      sourceTitle: String(row.sourceTitle),
      ...(row.anchor != null ? { anchor: String(row.anchor) } : {}),
      status: String(row.status),
    }));
  });
}

export async function forwardLinks(
  config: ResolvedConfig,
  noteId: string,
  options: { limit?: number } = {},
): Promise<ForwardLinkResult[]> {
  const limit = validateLimit(options.limit);
  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH (src:Note {id: $noteId})-[r:LINKS_TO]->(dst:Note)
       RETURN dst.id AS targetId, dst.title AS targetTitle, r.anchor AS anchor, dst.status AS status
       ORDER BY dst.id${limit ? " LIMIT $limit" : ""}`,
      { noteId, ...(limit ? { limit } : {}) },
    );
    return rows.map((row) => ({
      targetId: String(row.targetId),
      targetTitle: String(row.targetTitle),
      ...(row.anchor != null ? { anchor: String(row.anchor) } : {}),
      status: String(row.status),
    }));
  });
}

export async function descendants(
  config: ResolvedConfig,
  noteId: string,
  options: { depth?: number } = {},
): Promise<DescendantResult[]> {
  const depth = validateDepth(options.depth);
  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH path = (a:Note {id: $noteId})-[:HAS_CHILD*1..${depth ?? ""}]->(b:Note)
       RETURN b.id AS id, b.title AS title, length(path) AS depth, b.status AS status
       ORDER BY depth, b.id`,
      { noteId },
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      depth: Number(row.depth),
      status: String(row.status),
    }));
  });
}

export async function ancestors(
  config: ResolvedConfig,
  noteId: string,
  options: { depth?: number } = {},
): Promise<AncestorResult[]> {
  const depth = validateDepth(options.depth);
  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH path = (a:Note)-[:HAS_CHILD*1..${depth ?? ""}]->(b:Note {id: $noteId})
       RETURN a.id AS id, a.title AS title, length(path) AS depth, a.status AS status
       ORDER BY depth, a.id`,
      { noteId },
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      depth: Number(row.depth),
      status: String(row.status),
    }));
  });
}

export async function orphans(config: ResolvedConfig): Promise<OrphanResult[]> {
  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH (n:Note)
       WHERE n.id <> $rootId
         AND NOT EXISTS { MATCH (n)<-[:LINKS_TO]-(:Note) }
         AND NOT EXISTS { MATCH (n)-[:LINKS_TO]->(:Note) }
         AND NOT EXISTS { MATCH (n)-[:DECLARES_CODE_REF]->(:CodeSymbol) }
       RETURN n.id AS id, n.title AS title, n.status AS status
       ORDER BY n.id`,
      { rootId: "root" },
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status),
    }));
  });
}

export async function relatedNotes(
  config: ResolvedConfig,
  noteId: string,
  options: { limit?: number } = {},
): Promise<RelatedNoteResult[]> {
  const limit = validateLimit(options.limit);
  return withGraphConnection(config, async (conn) => {
    const tagRows = await queryRows(
      conn,
      `MATCH (me:Note {id: $noteId})-[:HAS_TAG]->(t:Tag)<-[:HAS_TAG]-(other:Note)
       WHERE other.id <> $noteId
       RETURN other.id AS id, other.title AS title, collect(t.name) AS sharedTags`,
      { noteId },
    );
    const backlinkRows = await queryRows(
      conn,
      `MATCH (src:Note)-[:LINKS_TO]->(me:Note {id: $noteId}),
             (src)-[:LINKS_TO]->(other:Note)
       WHERE other.id <> $noteId
       RETURN other.id AS id, other.title AS title, count(DISTINCT src) AS commonBacklinks`,
      { noteId },
    );

    const related = new Map<string, RelatedNoteResult>();
    for (const row of tagRows) {
      related.set(String(row.id), {
        id: String(row.id),
        title: String(row.title),
        sharedTags: (row.sharedTags as unknown[]).map(String).sort(),
        commonBacklinks: 0,
      });
    }
    for (const row of backlinkRows) {
      const id = String(row.id);
      const existing = related.get(id);
      if (existing) {
        existing.commonBacklinks = Number(row.commonBacklinks);
      } else {
        related.set(id, {
          id,
          title: String(row.title),
          sharedTags: [],
          commonBacklinks: Number(row.commonBacklinks),
        });
      }
    }

    const hits = [...related.values()].sort(
      (a, b) =>
        b.sharedTags.length - a.sharedTags.length ||
        b.commonBacklinks - a.commonBacklinks ||
        a.id.localeCompare(b.id),
    );
    return limit ? hits.slice(0, limit) : hits;
  });
}

export async function codeImpact(
  config: ResolvedConfig,
  target: { file?: string; symbol?: string },
): Promise<CodeImpactResult[]> {
  // Null query parameters break LadybugDB's parameter type inference, so the
  // WHERE clause is composed from whichever of file/symbol was provided.
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (target.file) {
    conditions.push("s.file = $file");
    params.file = target.file;
  }
  if (target.symbol) {
    conditions.push("s.symbol = $symbol");
    params.symbol = target.symbol;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return withGraphConnection(config, async (conn) => {
    const rows = await queryRows(
      conn,
      `MATCH (n:Note)-[:DECLARES_CODE_REF]->(s:CodeSymbol)
       ${where}
       RETURN n.id AS noteId, n.title AS title, s.file AS file, s.symbol AS symbol, s.kind AS kind
       ORDER BY n.id, s.file, s.symbol`,
      params,
    );
    return rows.map((row) => ({
      noteId: String(row.noteId),
      title: String(row.title),
      file: String(row.file),
      symbol: String(row.symbol),
      kind: String(row.kind),
    }));
  });
}

export async function cycles(
  config: ResolvedConfig,
  options: { limit?: number } = {},
): Promise<CycleResult[]> {
  const limit = validateLimit(options.limit);
  return withGraphConnection(config, async (conn) => {
    // LadybugDB variable-length patterns use walk semantics, so a Cypher-side
    // `(a)-[:LINKS_TO*1..]->(a)` returns walks that loop around a cycle any
    // number of times instead of elementary cycles. Detect cycles in-process
    // from the plain edge list instead.
    const rows = await queryRows(
      conn,
      "MATCH (a:Note)-[:LINKS_TO]->(b:Note) RETURN a.id AS fromId, b.id AS toId",
      {},
    );
    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const from = String(row.fromId);
      const targets = adjacency.get(from) ?? [];
      targets.push(String(row.toId));
      adjacency.set(from, targets);
    }
    for (const targets of adjacency.values()) targets.sort();

    const found = new Map<string, CycleResult>();
    const color = new Map<string, "gray" | "black">();
    const path: string[] = [];

    const visit = (id: string) => {
      color.set(id, "gray");
      path.push(id);
      for (const target of adjacency.get(id) ?? []) {
        if (color.get(target) === "gray") {
          // Back edge: the slice of the current DFS path from `target` is a cycle.
          const cycleNodes = canonicalCycle(path.slice(path.indexOf(target)));
          const key = cycleNodes.join(" ");
          if (!found.has(key)) {
            found.set(key, { path: [...cycleNodes, cycleNodes[0] as string] });
          }
        } else if (!color.has(target)) {
          visit(target);
        }
      }
      path.pop();
      color.set(id, "black");
    };
    for (const id of [...adjacency.keys()].sort()) {
      if (!color.has(id)) visit(id);
    }

    const hits = [...found.values()].sort((a, b) => a.path.join("").localeCompare(b.path.join("")));
    return limit ? hits.slice(0, limit) : hits;
  });
}

/**
 * Canonical rotation for a cycle given as its node ids (without the closing
 * repeat): the lexicographically smallest rotation, so the same cycle found
 * from different back edges dedupes to one entry.
 */
function canonicalCycle(nodes: string[]): string[] {
  let best = nodes;
  for (let i = 1; i < nodes.length; i += 1) {
    const rotated = [...nodes.slice(i), ...nodes.slice(0, i)];
    if (rotated.join(" ").localeCompare(best.join(" ")) < 0) best = rotated;
  }
  return best;
}

function withGraphConnection<T>(
  config: ResolvedConfig,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  requireGraphIndex(config);
  return withConnectionForConfig(config, fn);
}

function requireGraphIndex(config: ResolvedConfig): void {
  if (!config.search.enabled) {
    throw new Error("semantic-layer graph: search is disabled (search.enabled: false)");
  }
  const dbFile = dbFileForConfig(config);
  if (!existsSync(dbFile)) {
    throw new Error(
      `semantic-layer graph: no index found at ${dbFile}. Run \`semantic-layer index\` first.`,
    );
  }
  const staleness = indexStalenessReason(config);
  if (staleness) {
    console.warn(
      `semantic-layer graph: ${staleness}; results may be stale. Run \`semantic-layer index\` to refresh.`,
    );
  }
}

function indexStalenessReason(config: ResolvedConfig): string | undefined {
  const meta = readIndexMeta(config);
  if (!meta) return "index metadata not found";
  const reasons = configStalenessReasons(config, meta);
  if (reasons.length > 0) return reasons[0];
  if (meta.lastIndexedSha && getHeadSha(config.repoRoot)) {
    if (!isAncestorOfHead(config.repoRoot, meta.lastIndexedSha)) {
      return "index is not on the current HEAD";
    }
  }
  return undefined;
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`semantic-layer graph: limit must be a positive integer, got ${limit}`);
  }
  return limit;
}

// LadybugDB cannot parameterize variable-length bounds (`*1..$depth` fails to
// parse), so the validated integer is inlined into the statement.
function validateDepth(depth: number | undefined): number | undefined {
  if (depth === undefined) return undefined;
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`semantic-layer graph: depth must be a positive integer, got ${depth}`);
  }
  return depth;
}
