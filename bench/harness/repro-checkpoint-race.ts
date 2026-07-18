/**
 * repro3: mirrors the real full-rebuild statement sequence EXACTLY, unlike repro2:
 * insert rows WITHOUT embeddings → one giant UNWIND SET embedding UPDATE (10,924 rows) →
 * bulk CREATE_VECTOR_INDEX → FTS drop+recreate → CHECKPOINT → FTS query → CHECKPOINT.
 * No onnxruntime, no semantic-layer code.
 */
import { Database, Connection } from "@ladybugdb/core";

const path = `${process.cwd()}/.tmp/bench/repro-db.lbug`;
const db = new Database(path, 2 * 1024 * 1024 * 1024, true, false, 0);
db.initSync();
const conn = new Connection(db);

function vec(row: number): number[] {
  const out = new Array<number>(512);
  for (let i = 0; i < 512; i += 1) out[i] = Math.sin(row * 7919 + i * 0.37) * 0.5 + 0.123456;
  return out;
}

await conn.query("INSTALL vector");
await conn.query("LOAD EXTENSION vector");
await conn.query("INSTALL FTS");
await conn.query("LOAD EXTENSION FTS");
await conn.query(
  "CREATE NODE TABLE Chunk(id STRING, embedding FLOAT[512], text STRING, PRIMARY KEY(id))",
);

// Rows WITHOUT embeddings (the real insertChunksBatch shape).
const insert = await conn.prepare(
  "UNWIND $rows AS row CREATE (c:Chunk {id: row.id, text: row.text})",
);
for (let offset = 0; offset < 11_000; offset += 1000) {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: `doc-${offset + i}`,
    text: `document ${offset + i} about retrieval augmented generation and vector search`,
  }));
  await conn.execute(insert, { rows });
}
console.error("insert ok");

// One giant SET UPDATE for all embeddings (the real updateChunkEmbeddings shape).
const allRows = Array.from({ length: 11_000 }, (_, i) => ({
  id: `doc-${i}`,
  embedding: vec(i),
}));
const update = await conn.prepare(
  "UNWIND $rows AS row MATCH (c:Chunk {id: row.id}) SET c.embedding = row.embedding",
);
await conn.execute(update, { rows: allRows });
console.error("big UPDATE ok");

await conn.query('CALL CREATE_VECTOR_INDEX("Chunk", "idx", "embedding")');
console.error("bulk vector index ok");

await conn.query('CALL CREATE_FTS_INDEX("Chunk", "text", ["text"])');
await conn.query('CALL DROP_FTS_INDEX("Chunk", "text")');
await conn.query('CALL CREATE_FTS_INDEX("Chunk", "text", ["text"])');
console.error("fts drop+recreate ok");

await conn.query("CHECKPOINT");
console.error("first CHECKPOINT ok");

// A SECOND connection on the same Database, as the pool does per unit of work — including the
// schema setup the product re-runs on every acquisition.
const conn2 = new Connection(db);
await conn2.init();
await conn2.query("INSTALL FTS");
await conn2.query("LOAD EXTENSION FTS");
await conn2.query("INSTALL vector");
await conn2.query("LOAD EXTENSION vector");
const prepared = await conn2.prepare(
  'CALL QUERY_FTS_INDEX("Chunk", "text", $q) YIELD node AS chunk, score RETURN chunk.id, score LIMIT 10',
);
const result = await conn2.execute(prepared, { q: "retrieval" });
const rows = Array.isArray(result) ? result[0] : result;
console.error(`fts query on conn2 ok (${rows ? (await rows.getAll()).length : 0} hits)`);

await conn2.query("CHECKPOINT");
console.error("second CHECKPOINT (on conn2) ok — no crash");
