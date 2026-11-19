# Benchmark harness

`bench.ts` turns a BEIR dataset into a semantic-layer vault (one note per
corpus document), builds the real index, and scores `fts` / `vector` /
`hybrid` modes against the official qrels (nDCG@10, Recall@100, MRR@10).

## Setup

```bash
mkdir -p .tmp/bench/datasets && cd .tmp/bench/datasets
for ds in scifact nfcorpus arguana fiqa; do
  curl -sSL -o "$ds.zip" "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/$ds.zip"
  unzip -q -o "$ds.zip"
done
```

## Build and run

The bundle is emitted inside `packages/semantic-layer/dist/` so externalized
dependencies resolve against the package's own `node_modules`:

```bash
pnpm exec tsup bench/harness/bench.ts --format esm \
  --config packages/semantic-layer/tsup.config.ts \
  --out-dir packages/semantic-layer/dist/bench \
  --external yaml --external gray-matter --external zod --external typescript

SEMANTIC_LAYER_MODEL_CACHE_DIR=.tmp/model-cache \
  node packages/semantic-layer/dist/bench/bench.js <dataset>            # build + evaluate
SEMANTIC_LAYER_MODEL_CACHE_DIR=.tmp/model-cache \
  node packages/semantic-layer/dist/bench/bench.js <dataset> eval-only  # reuse existing index
```

The harness uses the static embedder, the only local embedder the package
ships. Reports before 2026-11-18 used the removed ONNX nomic model; compare
with them only through `bench/2026-11-18-static-embedder-poc.md`, which
measured both side by side. Set `SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE=1` to
time a cold build; otherwise the shared embedding cache serves vectors from
earlier runs.

Do not rebuild the bundle while a run is in flight: `tsup` replaces the
hashed chunk files the running process still imports lazily, and the run dies
with `ERR_MODULE_NOT_FOUND` at its first late import.

Results are printed as one JSON line per mode, preceded by a `build` line
(notes, chunks, seconds) and an embedder line (load time, first query embed).
Each mode line carries `maxRssMb`, the process's peak resident set so far. The static model is
downloaded once into `.tmp/model-cache` (or the default `~/.cache/semantic-layer/models`).
Each result retains aggregate `queryMs` for historical comparison and includes
per-query `medianQueryMs` and `p95QueryMs` for latency reporting.

The harness accepts any BEIR layout with `corpus.jsonl`, `queries.jsonl`, and
`qrels/test.tsv`; use `fiqa` for the FiQA2018 scale run. It uses the real
SQLite/FTS5 index and reports actual timings only—never copy historical
LadybugDB results into a SQLite report.

`repro-checkpoint-race.ts` is retained solely as the linked historical
LadybugDB 0.18.2 reproducer for the 2026-07-18 report. It is not part of the
SQLite v2 harness or release gates. Re-running it requires a legacy checkout
or manually installing `@ladybugdb/core`.
