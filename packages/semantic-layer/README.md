# @madebywild/semantic-layer

![wild-semantic-layer cover](../../public/cover.webp)

Dendron-style semantic documentation for codebases where agents are first-class
readers. The package validates a Markdown vault like source code: frontmatter,
hierarchy, wikilinks, code references, freshness, and configured invariants all
compile before the docs are trusted.

## Install

```bash
pnpm add -D @madebywild/semantic-layer
```

Add scripts to the consuming project:

```json
{
  "scripts": {
    "docs:check": "semantic-layer check",
    "docs:index": "semantic-layer index"
  }
}
```

## Commands

```bash
semantic-layer check
semantic-layer index
semantic-layer init
semantic-layer --help
```

`check` is the default command, so `semantic-layer` and
`semantic-layer check` are equivalent.

## Config

Create `semantic-layer.config.yml` at the consumer repo root:

```yaml
vault: vault
root: .
index:
  file: HIERARCHY.md
frontmatter:
  requiredExtraFields: [layer]
externalInvariants:
  - id: runtime
    value: Node.js 24
    usedIn: [demo.runtime]
```

Resolution order is CLI flags, then config file, then defaults. Supported config
files are `semantic-layer.config.yml`, `semantic-layer.config.yaml`, and
`semantic-layer.config.json`.

| Field | Default | Purpose |
| --- | --- | --- |
| `vault` | `vault` | Directory containing Dendron-style notes. |
| `root` | `.` | Repo root used to resolve `code_refs[].file`. |
| `index.file` | `HIERARCHY.md` | Generated agent-facing index filename. |
| `frontmatter.requiredExtraFields` | `[]` | Project-specific required frontmatter fields. |
| `externalInvariants` | `[]` | Values that must appear in listed notes beside `{{token}}` markers. |

CLI overrides:

```bash
semantic-layer check --vault docs --root .
semantic-layer index --config ./semantic-layer.config.yml
```

## Vault Format

Notes live in one vault directory. Dot-separated filenames encode hierarchy:

```text
vault/
  root.md
  root.schema.yml
  auth.md
  auth.schema.yml
  auth.flow.md
  meta.agent-conventions.md
```

Each note needs frontmatter:

```yaml
---
id: auth.flow
title: Auth flow
desc: How login and callback token exchange works.
status: active
owner: eng@example.com
last_verified: 2026-05-13
ttl_days: 90
code_refs:
  - file: src/auth/gateway.ts
    symbol: handleAuthCallback
tags: [auth]
---
```

`id` must match the filename without `.md`. A note named `auth.flow.md` requires
its parent `auth.md`. The vault requires `root.md`.

## Validation Rules

`semantic-layer check` fails on:

- missing or malformed required frontmatter
- configured extra frontmatter fields that are absent
- `id` and filename mismatch
- missing hierarchy ancestors
- schema child mismatches in `*.schema.yml`
- broken `[[wikilinks]]`, including heading anchors
- missing `code_refs` files or symbols
- expired `last_verified + ttl_days` for non-deprecated notes
- configured invariant tokens or values missing from referenced notes

Deprecated notes are still checked for structure and links, but freshness is
skipped.

## Schemas

Schema files use Dendron-compatible fields:

```yaml
version: 1
schemas:
  - id: auth
    parent: root
    children: [flow, token-rotation]
```

For a closed schema, direct children must match `children`. Add
`namespace: true` to allow arbitrary direct children while keeping the schema
documented.

`root.schema.yml` can constrain top-level notes:

```yaml
version: 1
schemas:
  - id: root
    parent: root
    children: [auth, meta]
```

## Generated Index

`semantic-layer index` writes `vault/HIERARCHY.md`. Agents should read this file
first, then load only the notes relevant to the task.

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

## Programmatic API

```ts
import { runCheck, runIndex, runInit } from "@madebywild/semantic-layer";

const result = runCheck({ cwd: process.cwd() });
if (result.errors.length > 0) {
  throw new Error(result.errors.join("\n"));
}

runIndex();
runInit({ vault: "vault", owner: "eng@example.com" });
```

Exports:

- `loadConfig`
- `runCheck`
- `runIndex`
- `runInit`
- TypeScript types for config, notes, schemas, and check results

## Packaging Notes

The published package contains only `bin/`, `dist/`, `README.md`, and
`package.json`. The CLI bin is a small stable wrapper around `dist/cli.js`, so
workspace installs can create the executable before build output exists.
`publishConfig` pins npm as the registry and public access for the
`@madebywild` scope.

## Deployment

This package is deployed to npm as `@madebywild/semantic-layer` from the
repository's "Release Package" GitHub Actions workflow.

To publish:

1. Bump `packages/semantic-layer/package.json`.
2. Merge or push the version bump to `main`.
3. Create a matching semver git tag on that `main` commit, for example `v0.1.0`
   for package version `0.1.0`.
4. Push the tag, for example `git push origin v0.1.0`.
5. The workflow runs `pnpm check`, builds this package, validates the tag,
   verifies the tagged commit is contained in `origin/main`, skips the npm
   publish if the same version already exists, and otherwise runs
   `pnpm publish --access public --no-git-checks`.
6. The workflow creates the matching GitHub Release from the same tag with
   generated release notes.

Do not create the GitHub Release manually before publishing. The git tag is the
release source of truth, and it must match `v0.0.0`, for example `v0.1.0` for
`0.1.0`.

The workflow uses the `NPM_TOKEN` GitHub secret for npm authentication and
publishes the scoped package with public npm access.
