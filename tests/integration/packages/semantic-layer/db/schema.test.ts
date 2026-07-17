import {
  Connection,
  Database,
} from "../../../../../packages/semantic-layer/node_modules/@ladybugdb/core";
import { describe, expect, it } from "vitest";
import {
  createSchema,
  createVectorIndex,
  dropSchema,
  GRAPH_SCHEMA,
  SCHEMA_VERSION,
  VECTOR_INDEX_NAME,
} from "../../../../../packages/semantic-layer/src/db/schema.js";
import { createTempDir } from "../../../../helpers.js";

async function openConnection(
  dir: string,
): Promise<{ conn: Connection; db: Database; close: () => Promise<void> }> {
  const db = new Database(`${dir}/vault.lbug`);
  const conn = new Connection(db);
  await conn.init();
  return {
    conn,
    db,
    close: async () => {
      await conn.close();
      await db.close();
    },
  };
}

async function listTables(conn: Connection): Promise<string[]> {
  const result = await conn.query("CALL SHOW_TABLES() RETURN *");
  const rows = await result.getAll();
  return rows.map((row: Record<string, unknown>) => String(row.name)).sort();
}

async function listIndexes(
  conn: Connection,
): Promise<Array<{ table: string; name: string; type: string }>> {
  const result = await conn.query("CALL SHOW_INDEXES() RETURN *");
  const rows = await result.getAll();
  return rows.map((row: Record<string, unknown>) => ({
    table: String(row.table_name),
    name: String(row.index_name),
    type: String(row.index_type),
  }));
}

async function getEmbeddingType(conn: Connection): Promise<string | undefined> {
  const result = await conn.query('CALL table_info("Chunk") RETURN *');
  const rows = await result.getAll();
  const row = rows.find((r: Record<string, unknown>) => r.name === "embedding");
  return row ? String(row.type) : undefined;
}

describe("GRAPH_SCHEMA", () => {
  it("exposes a stable schema version", () => {
    expect(GRAPH_SCHEMA.version).toBe(SCHEMA_VERSION);
  });

  it("declares the expected node tables", () => {
    expect(GRAPH_SCHEMA.nodeTables.map((t) => t.name).sort()).toEqual([
      "Audience",
      "Chunk",
      "CodeSymbol",
      "Heading",
      "Note",
      "Schema",
      "Tag",
    ]);
  });

  it("declares the expected rel tables", () => {
    expect(GRAPH_SCHEMA.relTables.map((t) => t.name).sort()).toEqual([
      "CONTAINS_CHUNK",
      "DECLARES_CODE_REF",
      "HAS_AUDIENCE",
      "HAS_CHILD",
      "HAS_HEADING",
      "HAS_TAG",
      "LINKS_TO",
      "SCHEMA_CHILD",
    ]);
  });
});

describe("createSchema", () => {
  it("creates all node and rel tables", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      const tables = await listTables(conn);
      expect(tables).toHaveLength(GRAPH_SCHEMA.nodeTables.length + GRAPH_SCHEMA.relTables.length);
      for (const table of GRAPH_SCHEMA.nodeTables) {
        expect(tables).toContain(table.name);
      }
      for (const table of GRAPH_SCHEMA.relTables) {
        expect(tables).toContain(table.name);
      }
    } finally {
      await close();
      cleanup();
    }
  });

  it("creates the FTS index on Chunk.text", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      const indexes = await listIndexes(conn);
      expect(indexes.some((idx) => idx.table === "Chunk" && idx.type === "FTS")).toBe(true);
    } finally {
      await close();
      cleanup();
    }
  });

  it("is idempotent", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      await createSchema(conn);
      const tables = await listTables(conn);
      expect(tables).toHaveLength(GRAPH_SCHEMA.nodeTables.length + GRAPH_SCHEMA.relTables.length);
    } finally {
      await close();
      cleanup();
    }
  });
});

describe("dropSchema", () => {
  it("removes all tables and indexes", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      await createVectorIndex(conn, 384);
      await dropSchema(conn);
      const tables = await listTables(conn);
      expect(tables).toHaveLength(0);
    } finally {
      await close();
      cleanup();
    }
  });
});

describe("createVectorIndex", () => {
  it("creates an HNSW index with the default dimensions", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      await createVectorIndex(conn, 384);
      const indexes = await listIndexes(conn);
      expect(
        indexes.some(
          (idx) => idx.table === "Chunk" && idx.name === VECTOR_INDEX_NAME && idx.type === "HNSW",
        ),
      ).toBe(true);
      expect(await getEmbeddingType(conn)).toBe("FLOAT[384]");
    } finally {
      await close();
      cleanup();
    }
  });

  it("recreates the embedding column when dimensions change", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      await createVectorIndex(conn, 384);
      await createVectorIndex(conn, 768);
      const indexes = await listIndexes(conn);
      expect(
        indexes.some(
          (idx) => idx.table === "Chunk" && idx.name === VECTOR_INDEX_NAME && idx.type === "HNSW",
        ),
      ).toBe(true);
      expect(await getEmbeddingType(conn)).toBe("FLOAT[768]");
    } finally {
      await close();
      cleanup();
    }
  });

  it("is idempotent when called twice with the same dimensions", async () => {
    const { dir, cleanup } = createTempDir();
    const { conn, close } = await openConnection(dir);
    try {
      await createSchema(conn);
      await createVectorIndex(conn, 384);
      await createVectorIndex(conn, 384);
      const indexes = await listIndexes(conn);
      expect(
        indexes.filter((idx) => idx.table === "Chunk" && idx.name === VECTOR_INDEX_NAME),
      ).toHaveLength(1);
    } finally {
      await close();
      cleanup();
    }
  });
});
