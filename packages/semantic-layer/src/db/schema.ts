import type { Connection } from "@ladybugdb/core";
import { queryRows } from "./cypher.js";

export const SCHEMA_VERSION = 3;

export const DEFAULT_EMBEDDING_DIMENSIONS = 384;
export const VECTOR_INDEX_NAME = "chunk_embedding_idx";
/**
 * LadybugDB names FTS indexes after the indexed column when using CREATE_FTS_INDEX.
 * The indexed column is `searchText`, not `text`: LadybugDB 0.18.2's FTS tokenizer does not
 * treat newlines as token separators (tokens adjacent to line breaks fuse into unsearchable
 * compounds, e.g. "beta\ngamma"), and chunk text is full of newlines. `searchText` stores a
 * newline-normalized copy that is safe to index; `text` stays pristine for display.
 */
export const FTS_INDEX_NAME = "searchText";

export type ColumnDef = {
  name: string;
  type: string;
  pk?: boolean;
};

export type NodeTableDef = {
  name: string;
  columns: ColumnDef[];
};

export type RelTableDef = {
  name: string;
  from: string;
  to: string;
  columns?: ColumnDef[];
};

export type FtsIndexDef = {
  table: string;
  column: string;
  propertyNames: string[];
};

export type VectorIndexDef = {
  table: string;
  column: string;
  name: string;
};

export type GraphSchema = {
  version: number;
  nodeTables: NodeTableDef[];
  relTables: RelTableDef[];
  ftsIndexes: FtsIndexDef[];
  vectorIndexes: VectorIndexDef[];
};

export const GRAPH_SCHEMA: GraphSchema = {
  version: SCHEMA_VERSION,
  nodeTables: [
    {
      name: "Note",
      columns: [
        { name: "id", type: "STRING", pk: true },
        { name: "title", type: "STRING" },
        // `desc` is a reserved word in LadybugDB Cypher; backtick-escape it.
        { name: "`desc`", type: "STRING" },
        { name: "status", type: "STRING" },
        { name: "owner", type: "STRING" },
        { name: "lastVerified", type: "STRING" },
        { name: "ttlDays", type: "INT64" },
        { name: "file", type: "STRING" },
      ],
    },
    {
      name: "Chunk",
      columns: [
        { name: "id", type: "STRING", pk: true },
        { name: "noteId", type: "STRING" },
        { name: "chunkIndex", type: "INT64" },
        { name: "headingPath", type: "STRING" },
        { name: "text", type: "STRING" },
        { name: "searchText", type: "STRING" },
        { name: "modality", type: "STRING" },
        {
          name: "embedding",
          type: `FLOAT[${DEFAULT_EMBEDDING_DIMENSIONS}]`,
        },
      ],
    },
    {
      name: "Heading",
      columns: [
        { name: "id", type: "STRING", pk: true },
        { name: "noteId", type: "STRING" },
        { name: "slug", type: "STRING" },
        { name: "text", type: "STRING" },
        { name: "level", type: "INT64" },
      ],
    },
    {
      name: "Tag",
      columns: [{ name: "name", type: "STRING", pk: true }],
    },
    {
      name: "Audience",
      columns: [{ name: "name", type: "STRING", pk: true }],
    },
    {
      name: "CodeSymbol",
      columns: [
        { name: "id", type: "STRING", pk: true },
        { name: "file", type: "STRING" },
        { name: "symbol", type: "STRING" },
        { name: "kind", type: "STRING" },
      ],
    },
    {
      name: "Schema",
      columns: [
        { name: "id", type: "STRING", pk: true },
        { name: "title", type: "STRING" },
        { name: "namespace", type: "BOOLEAN" },
      ],
    },
  ],
  relTables: [
    { name: "HAS_CHILD", from: "Note", to: "Note" },
    { name: "LINKS_TO", from: "Note", to: "Note", columns: [{ name: "anchor", type: "STRING" }] },
    { name: "HAS_TAG", from: "Note", to: "Tag" },
    { name: "HAS_AUDIENCE", from: "Note", to: "Audience" },
    { name: "DECLARES_CODE_REF", from: "Note", to: "CodeSymbol" },
    { name: "SCHEMA_CHILD", from: "Schema", to: "Note" },
    { name: "CONTAINS_CHUNK", from: "Note", to: "Chunk" },
    { name: "HAS_HEADING", from: "Note", to: "Heading" },
  ],
  ftsIndexes: [{ table: "Chunk", column: "searchText", propertyNames: ["searchText"] }],
  vectorIndexes: [{ table: "Chunk", column: "embedding", name: VECTOR_INDEX_NAME }],
};

function createNodeTableSql(table: NodeTableDef, dimensions?: number): string {
  const columns = table.columns
    .filter((column) => !(table.name === "Chunk" && column.name === "embedding"))
    .map((column) => `${column.name} ${column.type}${column.pk ? " PRIMARY KEY" : ""}`);
  if (table.name === "Chunk" && dimensions !== undefined) {
    columns.push(`embedding FLOAT[${dimensions}]`);
  }
  return `CREATE NODE TABLE IF NOT EXISTS ${table.name}(${columns.join(", ")})`;
}

function createRelTableSql(table: RelTableDef): string {
  const propertyColumns = table.columns?.length
    ? `, ${table.columns.map((column) => `${column.name} ${column.type}`).join(", ")}`
    : "";
  return `CREATE REL TABLE IF NOT EXISTS ${table.name}(FROM ${table.from} TO ${table.to}${propertyColumns})`;
}

async function indexExists(
  conn: Connection,
  tableName: string,
  indexName: string,
): Promise<boolean> {
  const rows = await queryRows(conn, "CALL SHOW_INDEXES() RETURN *");
  return rows.some((row) => row.table_name === tableName && row.index_name === indexName);
}

async function tableExists(conn: Connection, tableName: string): Promise<boolean> {
  const rows = await queryRows(conn, "CALL SHOW_TABLES() RETURN *");
  return rows.some((row) => row.name === tableName);
}

async function getEmbeddingDimension(conn: Connection): Promise<number | undefined> {
  if (!(await tableExists(conn, "Chunk"))) return undefined;
  const rows = await queryRows(conn, 'CALL table_info("Chunk") RETURN *');
  const embeddingRow = rows.find((row) => row.name === "embedding");
  if (!embeddingRow) return undefined;
  const type = String(embeddingRow.type);
  const match = type.match(/FLOAT\[(\d+)\]/);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

export async function createSchema(conn: Connection, dimensions?: number): Promise<void> {
  await conn.query("INSTALL FTS");
  await conn.query("LOAD EXTENSION FTS");
  await conn.query("INSTALL vector");
  await conn.query("LOAD EXTENSION vector");

  for (const table of GRAPH_SCHEMA.nodeTables) {
    await conn.query(createNodeTableSql(table, dimensions));
  }
  for (const table of GRAPH_SCHEMA.relTables) {
    await conn.query(createRelTableSql(table));
  }

  for (const fts of GRAPH_SCHEMA.ftsIndexes) {
    if (await indexExists(conn, fts.table, FTS_INDEX_NAME)) continue;
    if (!(await columnExists(conn, fts.table, fts.column))) {
      // The table is from an older schema version and lacks the indexed column; the full
      // rebuild that follows (triggered by the schema-version check) recreates it properly.
      continue;
    }
    await createFtsIndex(conn, fts);
  }
}

function createFtsIndexSql(fts: FtsIndexDef): string {
  const properties = fts.propertyNames.map((name) => `"${name}"`).join(", ");
  return `CALL CREATE_FTS_INDEX("${fts.table}", "${fts.column}", [${properties}])`;
}

async function createFtsIndex(conn: Connection, fts: FtsIndexDef): Promise<void> {
  await conn.query(createFtsIndexSql(fts));
}

async function columnExists(
  conn: Connection,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  if (!(await tableExists(conn, tableName))) return false;
  const rows = await queryRows(conn, `CALL table_info("${tableName}") RETURN *`);
  return rows.some((row) => row.name === columnName);
}

/**
 * Rebuilds the FTS index from scratch over the current rows. LadybugDB 0.18.2's FTS delete
 * path is only consistent for rows that were indexed by the bulk CREATE_FTS_INDEX path — rows
 * indexed incrementally at insert time fail deletes with "term ... is missing during delete".
 * Incremental rebuilds DETACH DELETE chunks, so every build must end with the index in
 * bulk-built shape; this runs at the end of every build.
 */
export async function repairFtsIndex(conn: Connection): Promise<void> {
  for (const fts of GRAPH_SCHEMA.ftsIndexes) {
    if (await indexExists(conn, fts.table, FTS_INDEX_NAME)) {
      await conn.query(`CALL DROP_FTS_INDEX("${fts.table}", "${FTS_INDEX_NAME}")`);
    }
    await createFtsIndex(conn, fts);
  }
}

export async function dropSchema(conn: Connection): Promise<void> {
  // Drop indexes by their *discovered* names, not the current constants: a database left behind
  // by an older schema version may name its indexes differently (e.g. FTS "text" vs
  // "searchText"), and tables cannot be dropped while an index still references them.
  const indexRows = await queryRows(conn, "CALL SHOW_INDEXES() RETURN *");
  for (const row of indexRows) {
    const table = String(row.table_name);
    const name = String(row.index_name);
    const type = String(row.index_type);
    if (type === "FTS") {
      await conn.query(`CALL DROP_FTS_INDEX("${table}", "${name}")`);
    } else if (type === "HNSW") {
      await conn.query(`CALL DROP_VECTOR_INDEX("${table}", "${name}")`);
    }
  }

  for (const table of [...GRAPH_SCHEMA.relTables].reverse()) {
    await conn.query(`DROP TABLE IF EXISTS ${table.name}`);
  }

  for (const table of [...GRAPH_SCHEMA.nodeTables].reverse()) {
    await conn.query(`DROP TABLE IF EXISTS ${table.name}`);
  }
}

export async function createVectorIndex(conn: Connection, dimensions: number): Promise<void> {
  const currentDimension = await getEmbeddingDimension(conn);

  if (currentDimension === dimensions) {
    if (await indexExists(conn, "Chunk", VECTOR_INDEX_NAME)) {
      return;
    }
  } else {
    if (await indexExists(conn, "Chunk", VECTOR_INDEX_NAME)) {
      await conn.query(`CALL DROP_VECTOR_INDEX("Chunk", "${VECTOR_INDEX_NAME}")`);
    }
    if (await indexExists(conn, "Chunk", FTS_INDEX_NAME)) {
      await conn.query(`CALL DROP_FTS_INDEX("Chunk", "${FTS_INDEX_NAME}")`);
    }

    await conn.query("DROP TABLE IF EXISTS CONTAINS_CHUNK");
    await conn.query("DROP TABLE IF EXISTS Chunk");

    const chunkTable = GRAPH_SCHEMA.nodeTables.find((table) => table.name === "Chunk");
    if (!chunkTable) {
      throw new Error("Chunk table definition not found in GRAPH_SCHEMA");
    }
    await conn.query(createNodeTableSql(chunkTable, dimensions));

    const chunkFts = GRAPH_SCHEMA.ftsIndexes.find((fts) => fts.table === "Chunk");
    if (chunkFts) {
      await createFtsIndex(conn, chunkFts);
    }

    const containsChunkRel = GRAPH_SCHEMA.relTables.find(
      (table) => table.name === "CONTAINS_CHUNK",
    );
    if (containsChunkRel) {
      await conn.query(createRelTableSql(containsChunkRel));
    }
  }

  await conn.query(`CALL CREATE_VECTOR_INDEX("Chunk", "${VECTOR_INDEX_NAME}", "embedding")`);
}
