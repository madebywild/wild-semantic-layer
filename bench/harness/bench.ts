/**
 * BEIR benchmark harness for semantic-layer's search index.
 *
 * Converts a BEIR dataset (corpus.jsonl / queries.jsonl / qrels/test.tsv) into a semantic-layer
 * vault (one note per document), builds the real index (LadybugDB + local nomic embedder), then
 * scores fts / vector / hybrid modes with nDCG@10, Recall@100, MRR@10 against the official qrels.
 *
 * Usage: node out/bench.mjs <dataset-name>   (expects .tmp/bench/datasets/<name>/ on disk)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../packages/semantic-layer/src/config.js";
import { buildIndex } from "../../packages/semantic-layer/src/db/indexer.js";
import { closePooledDatabases } from "../../packages/semantic-layer/src/db/pool.js";
import { querySearch } from "../../packages/semantic-layer/src/db/queries/search.js";
import { createEmbedder } from "../../packages/semantic-layer/src/search/embedder.js";
import type { SearchMode } from "../../packages/semantic-layer/src/types.js";

const BENCH_ROOT = join(process.cwd(), ".tmp", "bench");
const DATASETS_DIR = join(BENCH_ROOT, "datasets");

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readQrels(path: string): Map<string, Map<string, number>> {
  const qrels = new Map<string, Map<string, number>>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [qid, docId, scoreRaw] = line.split("\t");
    const score = Number(scoreRaw);
    if (!qid || !docId || !Number.isFinite(score)) continue; // skips the header row
    let perQuery = qrels.get(qid);
    if (!perQuery) {
      perQuery = new Map();
      qrels.set(qid, perQuery);
    }
    perQuery.set(docId, score);
  }
  return qrels;
}

/** One note per corpus document; note id (the filename) is the BEIR corpus id, verbatim. */
function ensureVault(dataset: string): string {
  const dsDir = join(BENCH_ROOT, dataset);
  const vaultDir = join(dsDir, "vault");
  if (existsSync(vaultDir)) return dsDir;

  mkdirSync(vaultDir, { recursive: true });
  const corpus = readJsonl(join(DATASETS_DIR, dataset, "corpus.jsonl"));
  for (const doc of corpus) {
    const id = String(doc._id);
    const title = String(doc.title ?? "").trim() || id;
    const text = String(doc.text ?? "").trim();
    const desc = (text || title).replace(/\s+/g, " ").slice(0, 160) || "document";
    const note = [
      "---",
      `id: ${JSON.stringify(id)}`,
      `title: ${JSON.stringify(title)}`,
      `desc: ${JSON.stringify(desc)}`,
      "status: active",
      "owner: bench",
      "last_verified: 2026-07-17",
      "ttl_days: 365",
      "---",
      "",
      `# ${title}`,
      "",
      text,
      "",
    ].join("\n");
    writeFileSync(join(vaultDir, `${id}.md`), note);
  }
  writeFileSync(
    join(dsDir, "semantic-layer.config.yml"),
    ["vault: vault", "root: .", "search:", "  embedding:", "    provider: local", ""].join("\n"),
  );
  // An empty repo per dataset: the parent repo's HEAD would make every generated note look like
  // an uncommitted change, triggering the query-time staleness path (and its git spawns) per query.
  execFileSync("git", ["init", "-q"], { cwd: dsDir });
  console.error(`vault: wrote ${corpus.length} notes for ${dataset}`);
  return dsDir;
}

function dedupeByNote(hits: Array<{ noteId: string }>): string[] {
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.noteId)) continue;
    seen.add(hit.noteId);
    ranked.push(hit.noteId);
  }
  return ranked;
}

function ndcgAtK(ranked: string[], gains: Map<string, number>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((docId, index) => {
    dcg += (gains.get(docId) ?? 0) / Math.log2(index + 2);
  });
  const ideal = [...gains.values()].sort((a, b) => b - a);
  let idcg = 0;
  ideal.slice(0, k).forEach((gain, index) => {
    idcg += gain / Math.log2(index + 2);
  });
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main(): Promise<void> {
  const dataset = process.argv[2];
  if (!dataset) throw new Error("usage: bench.mjs <dataset>");
  const dsDir = ensureVault(dataset);
  const config = loadConfig({ cwd: dsDir });
  const qrels = readQrels(join(DATASETS_DIR, dataset, "qrels", "test.tsv"));
  const queries = new Map(
    readJsonl(join(DATASETS_DIR, dataset, "queries.jsonl")).map((row) => [
      String(row._id),
      String(row.text),
    ]),
  );

  if (process.argv[3] === "eval-only") {
    console.error("eval-only: skipping index build, using existing index (WAL recovery on open)");
  } else {
    const t0 = performance.now();
    // No injected embedder: buildIndex creates and — crucially — CLOSES its own embedder inside
    // the connection callback, before the pool's post-callback CHECKPOINT. Injecting one keeps
    // 1-3 GB of ONNX arena resident through that checkpoint, which segfaults LadybugDB's buffer
    // manager at this scale (observed twice, same stack: finishCheckpoint → claimAFrame).
    const build = await buildIndex(config, { full: true });
    const indexSeconds = ((performance.now() - t0) / 1000).toFixed(1);
    console.error(
      `index: ${build.noteCount} notes, ${build.chunkCount} chunks in ${indexSeconds}s (${(
        build.noteCount / Number(indexSeconds)
      ).toFixed(1)} notes/s)`,
    );
  }
  const embedder = await createEmbedder(config.search.embedding);

  const queryIds = [...qrels.keys()].filter((qid) => queries.has(qid));
  for (const mode of ["fts", "vector", "hybrid"] satisfies SearchMode[]) {
    let ndcgSum = 0;
    let recallSum = 0;
    let mrrSum = 0;
    const start = performance.now();
    for (const [index, qid] of queryIds.entries()) {
      const result = await querySearch(
        config,
        { query: queries.get(qid) as string, mode, limit: 100 },
        { embedder },
      );
      const ranked = dedupeByNote(result.hits);
      const gains = qrels.get(qid) as Map<string, number>;
      ndcgSum += ndcgAtK(ranked, gains, 10);
      const top100 = new Set(ranked.slice(0, 100));
      const relevant = [...gains.keys()].filter((docId) => (gains.get(docId) ?? 0) > 0);
      recallSum += relevant.filter((docId) => top100.has(docId)).length / relevant.length;
      const firstRelevant = ranked.findIndex((docId) => (gains.get(docId) ?? 0) > 0);
      mrrSum += firstRelevant === -1 || firstRelevant >= 10 ? 0 : 1 / (firstRelevant + 1);
      if ((index + 1) % 200 === 0) console.error(`${mode}: ${index + 1}/${queryIds.length}`);
    }
    const seconds = (performance.now() - start) / 1000;
    console.log(
      JSON.stringify({
        dataset,
        mode,
        queries: queryIds.length,
        ndcg10: Number((ndcgSum / queryIds.length).toFixed(4)),
        recall100: Number((recallSum / queryIds.length).toFixed(4)),
        mrr10: Number((mrrSum / queryIds.length).toFixed(4)),
        queryMs: Number(((seconds * 1000) / queryIds.length).toFixed(1)),
      }),
    );
  }

  await embedder.close?.();
  await closePooledDatabases();
}

await main();
