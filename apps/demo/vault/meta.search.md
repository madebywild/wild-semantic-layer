---
id: meta.search
title: Search index
desc: Local full-text + vector search over this vault.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-08-18
ttl_days: 180
tags: [meta, search]
layer: demo
---

# Search index

Run `semantic-layer search-index` to build a local search index over this
vault, then `semantic-layer search "<query>"` to query it in `fts`, `vector`,
or `hybrid` mode. All generated search and graph state, including metadata,
lives in the single SQLite database `vault/.semantic-layer/vault.sqlite` and
is gitignored. SQLite may create transient `vault.sqlite-wal` and
`vault.sqlite-shm` sidecars while a process writes; they are not independent
index state. `search-index --full` regenerates the database from scratch, and
a plain `search-index` rebuilds incrementally.

The default local embedder runs `nomic-ai/nomic-embed-text-v1.5` (truncated to
512 dimensions) via `@huggingface/transformers` on `onnxruntime-node`, which
has no musl/Alpine build, so `search-index` degrades to an FTS-only index
there instead of failing. See [[meta.testing]] for how the containerized
suites cover this.

The index uses Node's built-in `node:sqlite` and SQLite FTS5. Search keeps a
per-process cache of vectors and filter metadata, refreshing changed notes
after successful writes and reloading when SQLite's data version changes.
Embeddings are Float32 BLOBs and vector retrieval is exact cosine similarity;
there is no native database module or vector extension to install.

SQLite runs in WAL mode with `synchronous=FULL`; every index mutation and its
FTS integrity check share one transaction. Corruption-class failures are
treated as recoverable derived state: the SQLite artifacts are quarantined and
the index is rebuilt. Existing `vault.lbug*` artifacts are deliberately left
untouched during migration; after a successful SQLite build, the CLI reports
that they are derived and safe to remove.

The committed BEIR report records historical LadybugDB measurements. Do not
compare those numbers with SQLite until a fresh run records its environment,
method, and results; the benchmark harness also documents FiQA2018 support for
the 57k-document scale target.
