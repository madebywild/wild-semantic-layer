# @madebywild/semantic-layer migrations

## Unreleased

Replaces the Orama search backend with [LadybugDB](https://ladybugdb.com), an
in-process property graph database. The search index and the vault graph are
now stored in a single `vault/.semantic-layer/vault.lbug` file. This is a
**breaking change**: any existing Orama search index files are ignored and can
be deleted.

### Breaking changes

- `semantic-layer index` now builds the LadybugDB vault index in addition to
  `HIERARCHY.md` and `code-refs.json`. With `search.enabled: false` it writes
  only the two sidecars and does not touch the database (and never loads the
  native module).
- The old `search-index` command is an alias for `index`.
- `search.indexFile` and `search.manifestFile` config keys are removed. The
  database path is fixed at `vault/.semantic-layer/vault.lbug` and its
  metadata sidecar is `vault/.semantic-layer/vault.lbug.meta.json`.
- Generated search/graph files changed:
  - `vault/.semantic-layer/vault.lbug`
  - `vault/.semantic-layer/vault.lbug.meta.json`
- Old Orama files (`search-index.msp`, `search-index.manifest.json`) are no
  longer produced and may be removed from `.gitignore`.

### Library API breaking changes

- `runSearchBuild` and `runSearchQuery` are removed. Use `runSearch(options)`
  (returns `{ mode, hits, stale, rebuilt }`).
- `runIndex` / `indexResolved` are now async and return
  `{ db, outFile, codeRefsFile, noteCount }` (`db` is undefined when
  `search.enabled` is false). They accept an optional `embedder` for tests.
- `runRefinementPromote` is now async.
- `SearchBuildDeps` / `SearchBuildOptions` / `SearchBuildResult` are removed;
  `BuildIndexResult` is exported instead, plus the `graph` result types.
- New export: `runGraph(options)`.
- Platform requirement: `@ladybugdb/core` is a native module that needs
  glibc + OpenSSL 3. `check`, `init`, and `refine stage|list|reject` load no
  native code and work anywhere; `index`, `search`, `graph`, and
  `refine promote` require a supported platform.

### New commands

```bash
semantic-layer search "<query>" [--mode fts|vector|hybrid] [--limit <n>]
  [--status <v>] [--tag <v>] [--audience <v>] [--json] [--rebuild]

semantic-layer graph <subcommand> [options]
semantic-layer graph backlinks <noteId>
semantic-layer graph links <noteId>
semantic-layer graph descendants <noteId> [--depth <n>]
semantic-layer graph ancestors <noteId> [--depth <n>]
semantic-layer graph orphans
semantic-layer graph related <noteId> [--limit <n>]
semantic-layer graph impact [--file <path>] [--symbol <name>]
semantic-layer graph cycles [--limit <n>]
```

`search` builds the index automatically on first use and warns (or rebuilds
with `--rebuild`) when the vault has changed since the last index run.

### Updated generated files (gitignored)

- `vault/.semantic-layer/vault.lbug`
- `vault/.semantic-layer/vault.lbug.meta.json`
- `vault/.semantic-layer/vault.lbug.wal` (transient WAL)

If you maintain your own `.gitignore`, replace the old Orama entries with:

```
**/.semantic-layer/vault.lbug
**/.semantic-layer/vault.lbug.wal
**/.semantic-layer/vault.lbug.meta.json
**/.semantic-layer/vault.lbug.meta.json.tmp
```

### Config block (all fields optional; shown with their defaults)

```yaml
search:
  enabled: true
  chunking:
    strategy: heading
    maxChunkChars: 2000
  embedding:
    provider: fastembed
  defaultMode: hybrid
  defaultLimit: 10
```

`search.indexFile` and `search.manifestFile` are no longer accepted.

### New / changed dependencies

`@ladybugdb/core` is a new runtime dependency. `@orama/orama` and
`@orama/plugin-data-persistence` are removed. `fastembed` remains an optional
dependency for local embeddings.

### New environment variables

- `SEMANTIC_LAYER_FASTEMBED_CACHE_DIR` — overrides where the local fastembed
  model is cached (default `$XDG_CACHE_HOME/semantic-layer/fastembed`, or
  `~/.cache/semantic-layer/fastembed` when `XDG_CACHE_HOME` is unset).
- `SEMANTIC_LAYER_GEMINI_API_KEY` (falls back to `GEMINI_API_KEY`) — API key
  for the optional hosted `gemini` embedding provider.

### Alpine / musl

LadybugDB itself is a native module and requires glibc + OpenSSL 3, so on
`node:*-alpine` or similar only the non-database commands work: `check`,
`init`, and `refine stage|list|reject`. `index`, `search`, `graph`, and
`refine promote` need a glibc-based image. Independently, `fastembed` has no
musl build either — on glibc platforms where the fastembed native bindings
fail to load, `index` degrades to an FTS-only index instead of failing
(`search --mode fts` keeps working; `--mode vector`/`--mode hybrid` fail with
an actionable message), or set `search.embedding.provider: gemini`.

## 0.3.0

`0.3.0` changes `code_refs` from text-regex declaration matching to
TypeScript compiler-backed symbol resolution.

### What stays compatible

Existing refs keep working when they point at TypeScript or JavaScript source:

```yaml
code_refs:
  - file: src/service.js
    symbol: issueToken
```

Consumers do not need to install `typescript`; it is now a runtime dependency of
`@madebywild/semantic-layer`.

### Optional disambiguation

If `semantic-layer check` reports an ambiguous symbol, add `kind`,
`namespace`, or both:

```yaml
code_refs:
  - file: src/service.ts
    symbol: Service
    kind: class
    namespace: value
```

### Removed regex behavior

Python-style `def` matches are no longer accepted as code refs. The resolver is
scoped to `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`
source files.

### Generated metadata

`semantic-layer index` now writes `vault/.semantic-layer/code-refs.json` by
default. To use a different sidecar path, set:

```yaml
index:
  codeRefsFile: generated/code-refs.json
```

`ResolvedConfig.index.codeRefsFile` is optional in the exported TypeScript type
for source compatibility with existing tests and integrations that construct
`ResolvedConfig` literals. `loadConfig` still fills the default at runtime.
