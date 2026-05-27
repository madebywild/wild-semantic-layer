# @madebywild/semantic-layer

![wild-semantic-layer cover](../../public/cover.webp)

`@madebywild/semantic-layer` turns a Markdown documentation vault into a checked
knowledge graph for humans and coding agents. It is designed for repositories
that treat documentation as part of the source tree: notes describe durable
product, architecture, API, and operational facts, and those notes must validate
before an agent can rely on them.

The package follows Dendron-style conventions where dot-separated filenames
encode hierarchy, wikilinks connect related notes, schemas constrain allowed
children, and frontmatter records ownership, status, freshness, and code
references. `semantic-layer check` compiles that vault by validating structure,
links, referenced source symbols, time-to-live freshness, project-specific
frontmatter, configured external invariants, and refinement metadata.

It also provides the workflow pieces agents need around the vault:

- `semantic-layer index` writes an agent-facing `HIERARCHY.md` and a generated
  code reference sidecar so readers can orient themselves before loading
  individual notes.
- `semantic-layer init` creates the minimal config, root notes, conventions, and
  schemas needed to start a new vault.
- `semantic-layer refine` stages, promotes, and rejects untrusted
  self-improvement signals without merging raw chat or transient context into
  trusted documentation.

Use it when a repo needs documentation that is navigable, testable, and safe to
hand to autonomous tools as current project context.

## Getting the Most from Agents

The package is most useful when the validator is part of the agent's normal
workflow, not just a command humans remember to run. Add a prompt fragment like
the one below to `AGENTS.md`, `CLAUDE.md`, Codex instructions, or the equivalent
agent configuration for the consuming repository.

That prompt makes agents read the generated hierarchy first, load only relevant
trusted notes, follow `code_refs` before changing code, and keep the vault
current after their work. In practice, this helps agents get much more out of the
package because the semantic layer becomes their source of durable project
context instead of passive documentation.

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
- Stage significant non-assistant inputs with `semantic-layer refine stage` when
  they may refine the graph but should not be trusted directly yet.
- Promote staged refinements only after updating the trusted vault, then reject
  shallow, faulty, secret-bearing, or obsolete staged inputs with a reason.
- Run `semantic-layer check` and `semantic-layer index`; do not hand off until
  both pass or the exact failures are reported.
```

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
semantic-layer refine stage --source user-message --title "Runtime changed" --stdin
semantic-layer refine list --status staged
semantic-layer --help
```

`check` is the default command, so `semantic-layer` and
`semantic-layer check` are equivalent.

`init` creates semantic-layer bootstrap files only: config, root metadata, agent
conventions, and matching schemas. It does not create sample product,
architecture, or infrastructure notes.

## Config

Create `semantic-layer.config.yml` at the consumer repo root:

```yaml
vault: vault
root: .
index:
  file: HIERARCHY.md
  codeRefsFile: .semantic-layer/code-refs.json
frontmatter:
  requiredExtraFields: [layer]
externalInvariants:
  - id: runtime
    value: Node.js 24
    usedIn: [demo.runtime]
evolution:
  stagingDir: vault/.semantic-layer/refinements
```

Resolution order is CLI flags, then config file, then defaults. Supported config
files are `semantic-layer.config.yml`, `semantic-layer.config.yaml`, and
`semantic-layer.config.json`.

| Field | Default | Purpose |
| --- | --- | --- |
| `vault` | `vault` | Directory containing Dendron-style notes. |
| `root` | `.` | Repo root used to resolve `code_refs[].file`. |
| `index.file` | `HIERARCHY.md` | Generated agent-facing index filename. |
| `index.codeRefsFile` | `.semantic-layer/code-refs.json` | Generated symbol metadata sidecar, relative to the vault directory. |
| `frontmatter.requiredExtraFields` | `[]` | Project-specific required frontmatter fields. |
| `externalInvariants` | `[]` | Values that must appear in listed notes beside `{{token}}` markers. |
| `evolution.stagingDir` | `<vault>/.semantic-layer/refinements` | Untrusted refinement lifecycle records. |

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
    kind: function
    namespace: value
tags: [auth]
---
```

`id` must match the filename without `.md`. A note named `auth.flow.md` requires
its parent `auth.md`. The vault requires `root.md`.

### Code References

`code_refs` point at real TypeScript or JavaScript symbols. The minimal shape is
still compatible with earlier versions:

```yaml
code_refs:
  - file: src/auth/gateway.ts
    symbol: handleAuthCallback
```

`semantic-layer check` resolves the referenced file with the TypeScript compiler
and accepts local declarations, exports, imports, aliases, re-exports, overload
sets, and JavaScript files. Supported source extensions are `.ts`, `.tsx`,
`.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`.

When the same symbol name has multiple candidates, add `kind` and/or
`namespace`:

```yaml
code_refs:
  - file: src/auth/types.ts
    symbol: AuthContext
    kind: interface
    namespace: type
```

Valid `kind` values are `function`, `class`, `const`, `let`, `var`, `interface`,
`type`, `enum`, `namespace`, `import`, `export`, `method`, and `property`.
Valid `namespace` values are `value`, `type`, and `namespace`.
Method and property references must be unique within the referenced file; if two
classes expose the same member name, move the reference to the containing class
or another unique declaration.

## Validation Rules

`semantic-layer check` fails on:

- missing or malformed required frontmatter
- configured extra frontmatter fields that are absent
- `id` and filename mismatch
- missing hierarchy ancestors
- schema child mismatches in `*.schema.yml`
- broken `[[wikilinks]]`, including heading anchors
- missing `code_refs` files or symbols
- ambiguous `code_refs` symbols that need `kind` and/or `namespace`
- unsupported `code_refs` source extensions
- expired `last_verified + ttl_days` for non-deprecated notes
- configured invariant tokens or values missing from referenced notes

Deprecated notes are still checked for structure and links, but freshness is
skipped.

If `evolution.stagingDir` exists, `check` also validates staged, promoted, and
rejected refinement metadata. Pending staged refinements do not fail `check` and
are not part of the trusted vault graph.

## Evolutionary Self-Improvement

The trusted knowledge graph remains the validated vault. The refinement staging
area is an untrusted heap for durable non-assistant project signals that may
improve the graph but should not be merged directly.

```bash
semantic-layer refine stage \
  --source user-message \
  --title "Runtime changed" \
  --related demo.runtime \
  --stdin

semantic-layer refine list --status staged
semantic-layer refine promote <id> --note demo.runtime
semantic-layer refine reject <id> --reason "Superseded by later decision"
```

`stage` stores a distilled summary, optional evidence snippets, related note
ids, and lifecycle metadata under `vault/.semantic-layer/refinements/staged/`.
It intentionally does not store raw chat transcripts by default.

`promote` is an assistant-driven handoff step: update the relevant `vault/*.md`
notes and schemas first, then run `semantic-layer refine promote <id> --note
<note-id>`. Promotion refuses to proceed if `semantic-layer check` fails, then
regenerates the index and moves the record to `promoted/`. Use `reject` for
faulty, shallow, secret-bearing, obsolete, or non-durable staged inputs.

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

`semantic-layer index` writes `vault/HIERARCHY.md` and
`vault/.semantic-layer/code-refs.json` by default. Agents should read
`HIERARCHY.md` first, then load only the notes relevant to the task.

The code refs sidecar is generated JSON:

```json
{
  "schema_version": 1,
  "refs": [
    {
      "note_id": "auth.flow",
      "ref": {
        "file": "src/auth/gateway.ts",
        "symbol": "handleAuthCallback",
        "kind": "function",
        "namespace": "value"
      },
      "kind": "function",
      "namespaces": ["value"],
      "line": 12,
      "column": 23,
      "declarations": [
        {
          "file": "src/auth/gateway.ts",
          "kind": "function",
          "line": 12,
          "column": 23
        }
      ]
    }
  ]
}
```

`index` validates note frontmatter, then resolves code refs only for valid notes
before writing either generated file. If a symbol is missing or ambiguous, it
leaves the previous generated files in place and reports the same code ref
failure that `check` would report.

## Migrating to 0.3

Version `0.3.0` replaces text-regex declaration matching with TypeScript
compiler-backed symbol resolution. Existing `file` + `symbol` references remain
valid for TypeScript and JavaScript sources, and `kind`/`namespace` are optional
additions for ambiguous names.

The stricter resolver no longer treats Python-style `def` text as a valid code
reference. Move non-JS/TS references into prose or split them into a future
language-specific integration. Consumers do not need to install TypeScript
separately because it is a runtime dependency of `@madebywild/semantic-layer`.
See [`MIGRATIONS.md`](MIGRATIONS.md) for the versioned checklist.

## Programmatic API

```ts
import {
  runCheck,
  runIndex,
  runInit,
  runRefinementStage,
} from "@madebywild/semantic-layer";

const result = runCheck({ cwd: process.cwd() });
if (result.errors.length > 0) {
  throw new Error(result.errors.join("\n"));
}

const index = runIndex();
console.log(index.codeRefsFile);
runInit({ vault: "vault", owner: "eng@example.com" });
runRefinementStage({
  source: "user-message",
  title: "Runtime changed",
  summary: "The runtime contract now targets Node.js 24.",
  relatedNotes: ["demo.runtime"],
});
```

Exports:

- `loadConfig`
- `runCheck`
- `runIndex`
- `runInit`
- `runRefinementStage`
- `runRefinementList`
- `runRefinementPromote`
- `runRefinementReject`
- TypeScript types for config, notes, schemas, and check results
