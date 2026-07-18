# Benchmark harness

`bench.ts` turns a BEIR dataset into a semantic-layer vault (one note per
corpus document), builds the real index, and scores `fts` / `vector` /
`hybrid` modes against the official qrels (nDCG@10, Recall@100, MRR@10).

## Setup

```bash
mkdir -p .tmp/bench/datasets && cd .tmp/bench/datasets
for ds in scifact nfcorpus arguana; do
  curl -sSL -o "$ds.zip" "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/$ds.zip"
  unzip -q -o "$ds.zip"
done
```

## Build and run

The bundle is emitted inside `packages/semantic-layer/dist/` so externalized
dependencies resolve against the package's own `node_modules`:

```bash
pnpm exec tsup bench/harness/bench.ts --format esm \
  --out-dir packages/semantic-layer/dist/bench \
  --external @ladybugdb/core --external @huggingface/transformers \
  --external yaml --external gray-matter --external zod --external typescript

SEMANTIC_LAYER_MODEL_CACHE_DIR=.tmp/model-cache \
  node packages/semantic-layer/dist/bench/bench.js <dataset>            # build + evaluate
SEMANTIC_LAYER_MODEL_CACHE_DIR=.tmp/model-cache \
  node packages/semantic-layer/dist/bench/bench.js <dataset> eval-only  # reuse existing index
```

Results are printed as one JSON line per mode. The local model is downloaded
once into `.tmp/model-cache` (or the default `~/.cache/semantic-layer/models`).

`repro-checkpoint-race.ts` is the clean-room probe for the LadybugDB 0.18.2
checkpoint crash documented in the 2026-07-18 report: it replays the full
index-build statement sequence (11k rows, giant embedding UPDATE, bulk HNSW,
FTS drop+recreate, CHECKPOINT, FTS query on a second connection, CHECKPOINT)
without any semantic-layer code. Build/run it the same way with
`--external @ladybugdb/core` after deleting `.tmp/bench/repro-db.lbug*`.
