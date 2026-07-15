---
id: meta.search
title: Search index
desc: Local full-text + vector search over this vault.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-07-15
ttl_days: 180
tags: [meta, search]
layer: demo
---

# Search index

Run `semantic-layer search-index` to build a local search index over this
vault, then `semantic-layer search "<query>"` to query it in `fts`, `vector`,
or `hybrid` mode. The generated index and manifest live under
`vault/.semantic-layer/` and are gitignored; `search-index --full` regenerates
them from scratch, and a plain `search-index` rebuilds incrementally.

The default local embedder (`fastembed`) has no musl/Alpine build, so
`search-index` degrades to an FTS-only index there instead of failing. See
[[meta.testing]] for the dedicated Alpine coverage this needs.
