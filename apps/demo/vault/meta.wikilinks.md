---
id: meta.wikilinks
title: Wikilink semantics
desc: Validated wikilink grammar shared by check and index.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-08-20
ttl_days: 180
tags: [meta, wikilinks, validation]
layer: demo
code_refs:
  - file: packages/semantic-layer/src/extract/wikilinks.ts
    symbol: extractVaultWikilinks
    kind: function
  - file: packages/semantic-layer/src/config.ts
    symbol: DEFAULT_WIKILINK_CONFIG
    kind: const
  - file: packages/semantic-layer/src/extract/wikilinks.ts
    symbol: headingKey
    kind: function
---

# Wikilink semantics

`semantic-layer check` and `semantic-layer index` use the same wikilink parser
and reject invalid links before graph state is trusted. Validation covers note
existence, heading existence and ambiguity, pipe count, empty targets, and
empty heading segments. Repeated links to the same semantic destination are
deduplicated before SQLite insertion.

The default `wikilinks.aliasOrder` is `dendron`, matching Dendron's documented
`[[alias|target]]` syntax and preserving existing vaults. Consumers importing
an Obsidian vault set `aliasOrder: obsidian` for its documented
`[[target|alias]]` syntax. The parser never guesses an order from current note
names because adding a note must not change an existing link's meaning.

Anchor-only links such as `[[#Local heading]]` target their source note.
Nested paths such as `[[note#Parent#Child]]` use every heading segment. A leaf
anchor may be abbreviated only when it resolves uniquely; otherwise validation
requires enough parent segments to disambiguate it. Matching is
case-insensitive while retaining punctuation and Unicode identity, and graph
edges store the shortest exact heading path that uniquely identifies the
destination.

Evidence and interoperability references:

- GitHub issue 4 records the original divergent behaviors:
  https://github.com/madebywild/wild-semantic-layer/issues/4
- Dendron documents generated aliases as `[[alias|note-name]]`:
  https://wiki.dendron.so/notes/mmi3gcxq9m0kz6ozocbqhok/
- Obsidian documents `[[target|alias]]`, same-note anchors, and nested heading
  paths: https://obsidian.md/help/links

See [[meta.testing]] for the layered validation gates and [[meta.search]] for
the SQLite graph/index contract.
