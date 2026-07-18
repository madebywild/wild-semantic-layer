---
id: meta.search
title: Search index
desc: Local full-text + vector search over this vault.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-07-17
ttl_days: 180
tags: [meta, search]
layer: demo
---

# Search index

Run `semantic-layer search-index` to build a local search index over this
vault, then `semantic-layer search "<query>"` to query it in `fts`, `vector`,
or `hybrid` mode. The generated LadybugDB index (`vault.lbug`) and its meta
sidecar live under `vault/.semantic-layer/` and are gitignored;
`search-index --full` regenerates them from scratch, and a plain
`search-index` rebuilds incrementally.

The default local embedder runs `nomic-ai/nomic-embed-text-v1.5` (truncated to
512 dimensions) via `@huggingface/transformers` on `onnxruntime-node`, which
has no musl/Alpine build, so `search-index` degrades to an FTS-only index
there instead of failing. See [[meta.testing]] for how the containerized
suites cover this.

Long-lived processes embedding the library keep one pooled database handle
open per process (see [[meta.testing]] for why); the on-disk file stays
complete between commands because the WAL is drained after every writing unit
of work (read-only units skip the no-op drain).

Scale notes from a BEIR benchmark run (5k-9k-note vaults, LadybugDB 0.18.2):
the HNSW vector index is built in one bulk pass after embeddings are stored —
the incremental per-UPDATE index path segfaults at ~5k vectors; embedding runs
in length-sorted batches of 32 (an unbounded bulk call OOM-kills, and naive
padding tripled indexing time); the buffer pool is capped at 2 GiB; and
read-only WAL drains are skipped because every checkpoint risks a native
checkpoint race that can corrupt the database on a crash. Hybrid mode won on
all three datasets (SciFact 0.725, NFCorpus 0.349, ArguAna 0.375 nDCG@10),
a few points above either fts or vector alone.
