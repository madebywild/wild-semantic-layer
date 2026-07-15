# @madebywild/semantic-layer migrations

## Unreleased

Adds `semantic-layer search-index` and `semantic-layer search`: a local,
file-based full-text + vector search index over the vault, built on
[Orama](https://github.com/oramasearch/orama). This is purely additive —
existing commands, config, and generated files are unaffected.

### New commands

```bash
semantic-layer search-index [--full]
semantic-layer search "<query>" [--mode fts|vector|hybrid] [--limit <n>]
  [--status <v>] [--tag <v>] [--audience <v>] [--json] [--rebuild]
```

### New generated files (gitignored)

- `vault/.semantic-layer/search-index.msp`
- `vault/.semantic-layer/search-index.manifest.json`

If you maintain your own `.gitignore` rather than relying on this package's
defaults, add:

```
**/.semantic-layer/search-index.msp
**/.semantic-layer/search-index.msp.tmp
**/.semantic-layer/search-index.manifest.json
**/.semantic-layer/search-index.manifest.json.tmp
```

### New config block (all fields optional; shown with their defaults)

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

### New dependencies

`@orama/orama` and `@orama/plugin-data-persistence` are new runtime
dependencies (pure JS, no native/install-script footprint). `fastembed` is a
new **optional** dependency — if its native ONNX/tokenizer bindings fail to
install on a given platform (e.g. musl/Alpine, see below), `npm install` still
succeeds; only the local embedder is affected.

### New environment variables

- `SEMANTIC_LAYER_FASTEMBED_CACHE_DIR` — overrides where the local fastembed
  model is cached (default `~/.cache/semantic-layer/fastembed`).
- `SEMANTIC_LAYER_GEMINI_API_KEY` (falls back to `GEMINI_API_KEY`) — API key
  for the optional hosted `gemini` embedding provider.

### Alpine / musl

`fastembed`'s native ONNX runtime and tokenizer bindings have no musl build,
so local embeddings can't load on `node:*-alpine` or similar. `search-index`
degrades to an FTS-only index instead of failing — `search --mode fts` keeps
working, `--mode vector`/`--mode hybrid` fail with an actionable message. Use
a glibc-based base image for local vector search inside a container, or set
`search.embedding.provider: gemini`.

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
