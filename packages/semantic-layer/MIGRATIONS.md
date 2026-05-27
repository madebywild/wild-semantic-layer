# @madebywild/semantic-layer migrations

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
