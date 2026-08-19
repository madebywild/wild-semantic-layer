---
id: meta.search
title: Search index
desc: Local full-text + vector search over this vault.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-08-19
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

FTS accepts ordinary user text rather than raw FTS5 syntax. It safely quotes
Unicode tokens, deduplicates them, removes a conservative set of common English
function words, and OR-composes the remaining terms. If filtering removes every
term, it falls back to the safe deduplicated tokens so short stopword-only
queries still work.

SQLite runs in WAL mode with `synchronous=FULL`; every index mutation and its
FTS integrity check share one transaction. Corruption-class failures are
treated as recoverable derived state: the SQLite artifacts are quarantined and
the index is rebuilt. Existing `vault.lbug*` artifacts are deliberately left
untouched during migration; after a successful SQLite build, the CLI reports
that they are derived and safe to remove.

`bench/2026-08-19-beir-sqlite-search.md` records the fresh SQLite ArguAna run:
17,802 chunks, FTS/vector/hybrid nDCG@10 of 0.3342/0.3442/0.3691, and median
latencies of 52.9/83.8/139.7 ms. The attempted 57,638-document FiQA run was
stopped after an overnight host suspension invalidated its build timing before
SQLite insertion began, so the report makes no FiQA performance claim.
