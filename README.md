# Wild Semantic Layer

A small PNPM monorepo for `@wild/semantic-layer`: a Dendron-style semantic
documentation layer that validates a Markdown vault like source code.

The package provides:

- `semantic-layer check` - validate frontmatter, hierarchy, schemas,
  wikilinks, code references, freshness, and configured invariants.
- `semantic-layer index` - regenerate `vault/HIERARCHY.md` for agents.
- `semantic-layer init` - scaffold a working vault and config.

See the package README for the consumer-facing reference:
[`packages/semantic-layer/README.md`](packages/semantic-layer/README.md).

## Workspace

```text
packages/semantic-layer  reusable package and CLI
apps/demo                live consumer app with a real vault
tests/e2e                blackbox CLI tests using Testcontainers
```

## Commands

```bash
pnpm install
pnpm build
pnpm demo
pnpm test
pnpm check
```

Use PNPM 11.1.1, as declared in `package.json`. `pnpm demo` builds the package,
validates and indexes the demo vault, then runs the demo app. `pnpm test` needs
Docker: it packs the package, installs it into a clean Node container, and runs
the CLI as a consumer would.
