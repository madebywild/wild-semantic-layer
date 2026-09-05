---
id: meta.hierarchy
title: Hierarchy rule
desc: Every dotted note needs its ancestor notes, enforced by check and index.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-09-05
ttl_days: 180
tags: [meta, hierarchy, validation]
layer: demo
code_refs:
  - file: packages/semantic-layer/src/extract/hierarchy.ts
    symbol: validateHierarchyAncestors
    kind: function
  - file: packages/semantic-layer/src/extract/hierarchy.ts
    symbol: extractHierarchyEdges
    kind: function
---

# Hierarchy rule

A dotted note id names its ancestors, and every one of those ancestors must
exist as a note. `demo.runtime.ui` needs both `demo.md` and `demo.runtime.md`.
There are no stub notes: `HIERARCHY.md` lists one row per real note, and a
`hierarchy_edges` row joins two real notes.

`semantic-layer check` and `semantic-layer index` apply this one rule and
report it in the same words, the same way they share the link grammar in
[[meta.wikilinks]]:

```text
[demo.runtime.ui] missing ancestor "demo.runtime.md" in the hierarchy
```

`index` applies the rule before it resolves code references, before it embeds,
and before it opens a write transaction. Until version 2.2.0 only `check` held
the rule, so a missing ancestor reached SQLite and stopped the build with
`FOREIGN KEY constraint failed`, which names neither the note nor the missing
parent. A search-disabled vault gets the same error, because it writes
`HIERARCHY.md` from the same validated notes. See [[meta.indexing]] for the
lock that the build takes around this work.
