import { existsSync } from "node:fs";
import { candidateNoteIdsSinceSha, getHeadSha, isAncestorOfHead } from "../../search/git-diff.js";
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
import {
  dbFileForConfig,
  isCorruptionError,
  recoverCorruptIndex,
  type SqliteConnection,
  withConnectionForConfig,
} from "../connection.js";
import { buildIndex } from "../indexer.js";
import { configStalenessReasons, readIndexMeta } from "../meta.js";
import { clearSearchCache } from "./cache.js";

/** Read-only graph queries over the normalized SQLite vault index. */
export async function backlinks(
  config: ResolvedConfig,
  noteId: string,
  options: { limit?: number } = {},
): Promise<BacklinkResult[]> {
  const limit = validateLimit(options.limit);
  return withGraphConnection(config, (conn) => {
    const rows = conn
      .prepare(
        `SELECT n.id AS sourceId, n.title AS sourceTitle, NULLIF(l.anchor, '') AS anchor, n.status
           FROM links l JOIN notes n ON n.id = l.source_id
          WHERE l.target_id = :noteId
          ORDER BY n.id${limit ? " LIMIT :limit" : ""}`,
      )
      .all(limit ? { noteId, limit } : { noteId }) as Record<string, unknown>[];
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
  return withGraphConnection(config, (conn) => {
    const rows = conn
      .prepare(
        `SELECT n.id AS targetId, n.title AS targetTitle, NULLIF(l.anchor, '') AS anchor, n.status
           FROM links l JOIN notes n ON n.id = l.target_id
          WHERE l.source_id = :noteId
          ORDER BY n.id${limit ? " LIMIT :limit" : ""}`,
      )
      .all(limit ? { noteId, limit } : { noteId }) as Record<string, unknown>[];
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
  return withGraphConnection(config, (conn) => {
    const rows = treeRows(conn, "parent_id", "child_id", noteId, depth);
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
  return withGraphConnection(config, (conn) => {
    const rows = treeRows(conn, "child_id", "parent_id", noteId, depth);
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      depth: Number(row.depth),
      status: String(row.status),
    }));
  });
}

/** Recursive CTEs retain the graph traversal behavior and avoid looping on malformed cycles. */
function treeRows(
  conn: SqliteConnection,
  fromColumn: "parent_id" | "child_id",
  toColumn: "parent_id" | "child_id",
  noteId: string,
  depth: number | undefined,
): Record<string, unknown>[] {
  // The only interpolated values are internal fixed column names and a validated integer.
  const depthWhere = depth === undefined ? "" : ` AND tree.depth < ${depth}`;
  return conn
    .prepare(
      `WITH RECURSIVE tree(id, depth, path) AS (
         SELECT ${toColumn}, 1, '|' || ${toColumn} || '|'
           FROM hierarchy_edges WHERE ${fromColumn} = :noteId
         UNION ALL
         SELECT e.${toColumn}, tree.depth + 1, tree.path || e.${toColumn} || '|'
           FROM hierarchy_edges e JOIN tree ON e.${fromColumn} = tree.id
          WHERE instr(tree.path, '|' || e.${toColumn} || '|') = 0${depthWhere}
       )
       SELECT n.id, n.title, MIN(tree.depth) AS depth, n.status
         FROM tree JOIN notes n ON n.id = tree.id
        GROUP BY n.id, n.title, n.status
        ORDER BY depth, n.id`,
    )
    .all({ noteId }) as Record<string, unknown>[];
}

export async function orphans(config: ResolvedConfig): Promise<OrphanResult[]> {
  return withGraphConnection(config, (conn) => {
    const rows = conn
      .prepare(
        `SELECT n.id, n.title, n.status
           FROM notes n
          WHERE n.id <> :rootId
            AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = n.id OR l.target_id = n.id)
            AND NOT EXISTS (SELECT 1 FROM note_code_references r WHERE r.note_id = n.id)
          ORDER BY n.id`,
      )
      .all({ rootId: "root" }) as Record<string, unknown>[];
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
  return withGraphConnection(config, (conn) => {
    const tagRows = conn
      .prepare(
        `SELECT other.id, other.title, shared.tag AS sharedTag
           FROM note_tags mine
           JOIN note_tags shared ON shared.tag = mine.tag AND shared.note_id <> :noteId
           JOIN notes other ON other.id = shared.note_id
          WHERE mine.note_id = :noteId`,
      )
      .all({ noteId }) as Record<string, unknown>[];
    const backlinkRows = conn
      .prepare(
        `SELECT other.id, other.title, COUNT(DISTINCT incoming.source_id) AS commonBacklinks
           FROM links incoming
           JOIN links other_link ON other_link.source_id = incoming.source_id
           JOIN notes other ON other.id = other_link.target_id
          WHERE incoming.target_id = :noteId AND other.id <> :noteId
          GROUP BY other.id, other.title`,
      )
      .all({ noteId }) as Record<string, unknown>[];

    const related = new Map<string, RelatedNoteResult>();
    for (const row of tagRows) {
      const id = String(row.id);
      const existing = related.get(id);
      if (existing) existing.sharedTags.push(String(row.sharedTag));
      else {
        related.set(id, {
          id,
          title: String(row.title),
          sharedTags: [String(row.sharedTag)],
          commonBacklinks: 0,
        });
      }
    }
    for (const row of backlinkRows) {
      const id = String(row.id);
      const existing = related.get(id);
      if (existing) existing.commonBacklinks = Number(row.commonBacklinks);
      else {
        related.set(id, {
          id,
          title: String(row.title),
          sharedTags: [],
          commonBacklinks: Number(row.commonBacklinks),
        });
      }
    }
    for (const hit of related.values()) hit.sharedTags.sort();
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
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (target.file) {
    where.push("s.file = :file");
    params.file = target.file;
  }
  if (target.symbol) {
    where.push("s.symbol = :symbol");
    params.symbol = target.symbol;
  }
  return withGraphConnection(config, (conn) => {
    const rows = conn
      .prepare(
        `SELECT n.id AS noteId, n.title, s.file, s.symbol, s.kind
           FROM note_code_references r
           JOIN notes n ON n.id = r.note_id
           JOIN code_symbols s ON s.id = r.code_symbol_id
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY n.id, s.file, s.symbol`,
      )
      .all(params) as Record<string, unknown>[];
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
  return withGraphConnection(config, (conn) => {
    // SQLite recursion can find reachability, but the established DFS below returns elementary,
    // canonical cycles rather than arbitrary repeated walks.
    const rows = conn
      .prepare("SELECT source_id AS fromId, target_id AS toId FROM links")
      .all() as Record<string, unknown>[];
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
          const cycleNodes = canonicalCycle(path.slice(path.indexOf(target)));
          const key = cycleNodes.join(" ");
          if (!found.has(key)) found.set(key, { path: [...cycleNodes, cycleNodes[0] as string] });
        } else if (!color.has(target)) {
          visit(target);
        }
      }
      path.pop();
      color.set(id, "black");
    };
    for (const id of [...adjacency.keys()].sort()) if (!color.has(id)) visit(id);

    const hits = [...found.values()].sort((a, b) => a.path.join("").localeCompare(b.path.join("")));
    return limit ? hits.slice(0, limit) : hits;
  });
}

function canonicalCycle(nodes: string[]): string[] {
  let best = nodes;
  for (let index = 1; index < nodes.length; index += 1) {
    const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
    if (rotated.join(" ").localeCompare(best.join(" ")) < 0) best = rotated;
  }
  return best;
}

function withGraphConnection<T>(
  config: ResolvedConfig,
  fn: (conn: SqliteConnection) => T | Promise<T>,
): Promise<T> {
  requireGraphIndex(config);
  const run = () =>
    withConnectionForConfig(config, async (conn) => {
      const staleness = indexStalenessReason(config, conn);
      if (staleness) {
        console.warn(
          `semantic-layer graph: ${staleness}; results may be stale. Run \`semantic-layer index\` to refresh.`,
        );
      }
      return fn(conn);
    });
  return run().catch(async (error: unknown) => {
    // `isCorruptionError` deliberately excludes logical FTS integrity failures. A physical index
    // failure is derived state, so quarantine it and make one full rebuild attempt before retry.
    if (isCorruptionError(error)) {
      recoverCorruptIndex(config);
      clearSearchCache(dbFileForConfig(config));
      await buildIndex(config, { full: true });
      return run();
    }
    throw error;
  });
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
}

function indexStalenessReason(config: ResolvedConfig, conn: SqliteConnection): string | undefined {
  const meta = readIndexMeta(config, conn);
  if (!meta) return "index metadata not found";
  const reasons = configStalenessReasons(config, meta);
  if (reasons.length > 0) return reasons[0];
  if (meta.lastIndexedSha) {
    if (!getHeadSha(config.repoRoot)) return "the vault is no longer in a git repository";
    if (!isAncestorOfHead(config.repoRoot, meta.lastIndexedSha))
      return "index is not on the current HEAD";
    if (
      candidateNoteIdsSinceSha(config.repoRoot, config.vaultDir, meta.lastIndexedSha).length > 0
    ) {
      return "the vault has changed since the index was last built";
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

function validateDepth(depth: number | undefined): number | undefined {
  if (depth === undefined) return undefined;
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`semantic-layer graph: depth must be a positive integer, got ${depth}`);
  }
  return depth;
}
