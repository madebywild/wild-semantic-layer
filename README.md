# wild-semantic-layer

![wild-semantic-layer cover](public/cover.webp)

A small PNPM monorepo for `@madebywild/semantic-layer`: a Dendron-style
semantic documentation layer that validates a Markdown vault like source code.

The package provides:

- `semantic-layer check` - validate frontmatter, hierarchy, schemas,
  wikilinks, code references, freshness, and configured invariants.
- `semantic-layer index` - regenerate `vault/HIERARCHY.md` for agents.
- `semantic-layer init` - scaffold a working vault and config.

See the package README for the consumer-facing reference:
[`packages/semantic-layer/README.md`](packages/semantic-layer/README.md).

## Agent Prompt Fragment

```md
### Semantic Layer

Pre task:

- If `vault/HIERARCHY.md` is missing or stale, run `semantic-layer index`.
- Read `vault/HIERARCHY.md` first, then open only the `vault/*.md` notes relevant
  to the task.
- Follow wikilinks and `code_refs` from relevant notes before changing code.

Post task:

- Create, update, or delete `vault/*.md` notes and `*.schema.yml` files for any
  behavior, API, architecture, or operational knowledge changed by the task.
- Keep frontmatter current, including `last_verified`, `ttl_days`, `code_refs`,
  wikilinks, schema children, and configured external invariants.
- Run `semantic-layer check` and `semantic-layer index`; do not hand off until
  both pass or the exact failures are reported.
```

## Workspace

```text
packages/semantic-layer  reusable package and CLI
apps/demo                live consumer app with a real vault
tests/unit               focused rule and helper coverage
tests/integration        source-level API workflow coverage
tests/e2e                blackbox CLI/package tests using Testcontainers
```

## Commands

```bash
pnpm install
pnpm build
pnpm demo
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm check
```

Use PNPM 11.1.1, as declared in `package.json`. `pnpm demo` builds the package,
validates and indexes the demo vault, then runs the demo app.

`pnpm test` runs the full Vitest workspace, including the Docker-backed e2e
package install test. `pnpm test:coverage` runs unit and integration tests with
coverage thresholds against `packages/semantic-layer/src`. `pnpm check` is the
release gate: formatting, linting, typecheck, measured coverage, e2e package
test, and demo showcase.

## Deployment

The package is published to npm as `@madebywild/semantic-layer` by
`.github/workflows/publish.yml`.

Publishing and GitHub releases are driven by semver git tags:

- merge or push the version bump to `main`
- create a semver tag on that `main` commit, such as `v0.1.0`
- push the tag with `git push origin v0.1.0`

The workflow installs dependencies with PNPM 11.1.1 on Node.js 24, runs the full
`pnpm check` release gate, builds `packages/semantic-layer`, checks whether the
current `package.json` version already exists on npm, and publishes only missing
versions from semver tag pushes with
`pnpm publish --access restricted --no-git-checks`. The release tag must match
`v0.0.0` format and must equal the package version, for example package version
`0.1.0` must be published from tag `v0.1.0`. The tagged commit must already be
contained in `origin/main`.

After the npm publish step succeeds, or if that exact npm version already
exists, the workflow creates the matching GitHub Release from the same tag with
generated release notes. Do not create a GitHub Release manually first; the git
tag is the release source of truth.

The workflow expects the repository secret `NPM_TOKEN` to contain an npm token
with publish access to the `@madebywild` scope. Bump
`packages/semantic-layer/package.json` before publishing a new release; npm will
not accept republishing an existing version. The package is configured for
private scoped publishing through `publishConfig.access: restricted`.
