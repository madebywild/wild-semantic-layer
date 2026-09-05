---
id: meta.search
title: Search index
desc: Local full-text + vector search over this vault.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-09-05
ttl_days: 180
tags: [meta, search]
layer: demo
code_refs:
  - file: packages/semantic-layer/src/search/embedding-cache.ts
    symbol: withEmbeddingCache
    kind: function
  - file: packages/semantic-layer/src/search/embedding-cache.ts
    symbol: embeddingCacheFileForConfig
    kind: function
  - file: packages/semantic-layer/src/search/git-diff.ts
    symbol: getGitCommonDir
    kind: function
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

A build does not embed text it has already embedded. Every document vector also
goes into a cache at `<repo>/.git/semantic-layer/embeddings.sqlite`, the one
path that every linked worktree of a repository resolves to, so a second
worktree builds its own index from stored vectors instead of running the model
again. Outside a git repository the cache falls back to
`vault/.semantic-layer/embeddings.sqlite`. An entry is addressed by the embedder
id, the dimensions, and the text, thus edited notes, changed chunking, and a
changed model all miss and recompute, and a hit gives the vector that a fresh
build would have written. Entries unused for 30 days are dropped when the
embedder closes. A corrupt or unwritable cache is removed and rebuilt, and a
store that still fails only costs the run its reuse.
`SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE=1` switches the cache off.

Index writes are also serialized across processes: see [[meta.indexing]] for the
per-vault lock that makes a second concurrent index run fail fast instead of
racing this database and the generated files.

SQLite runs in WAL mode with `synchronous=FULL`; every index mutation and its
FTS integrity check share one transaction. Corruption-class failures are
identified from SQLite error codes rather than arbitrary component error text,
then treated as recoverable derived state: the SQLite artifacts are quarantined
and the index is rebuilt. Quarantine files are gitignored for diagnosis or
later removal. Existing `vault.lbug*` artifacts are deliberately left untouched
during migration; after a successful SQLite build, the CLI reports that they
are derived and safe to remove.

`bench/2026-08-19-beir-sqlite-search.md` records the fresh SQLite ArguAna run:
17,802 chunks, FTS/vector/hybrid nDCG@10 of 0.3342/0.3442/0.3691, and median
latencies of 52.9/83.8/139.7 ms. The attempted 57,638-document FiQA run was
stopped after an overnight host suspension invalidated its build timing before
SQLite insertion began, so the report makes no FiQA performance claim.
