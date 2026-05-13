# System Prompt

You have full autonomy. Proceed without asking for confirmation — read, write, execute, and search freely. Prefer action over discussion.

## Agent Configuration

All MCP servers, prompts, skills, subagents, and agent settings must be configured exclusively inside the `.harness/` folder. After making any changes there, run `pnpm harness apply` to sync the configuration to all agents.

---

## Project: wild-semantic-layer

A pnpm monorepo (pnpm 11.1.1) for `@madebywild/semantic-layer`: a Dendron-style semantic documentation validator and indexer. Docs are treated like source code — they must compile before they are trusted by agents.

### Workspace layout

```
packages/semantic-layer/   the reusable library and CLI  (published as @madebywild/semantic-layer)
apps/demo/                 live consumer app with a real vault
tests/e2e/                 blackbox CLI tests (Testcontainers + Vitest)
tests/integration/         source-level API workflow tests
tests/unit/                focused unit tests for rules and helpers
```

Root scripts:

| Script | What it does |
| --- | --- |
| `pnpm build` | builds all packages (`tsup`) |
| `pnpm format:check` | checks formatting with Biome |
| `pnpm lint` | lints the workspace with Biome |
| `pnpm test` | runs all Vitest projects (requires Docker for e2e) |
| `pnpm test:coverage` | runs unit + integration tests with coverage thresholds |
| `pnpm test:e2e` | runs the Docker-backed package install CLI test |
| `pnpm check` | full handoff gate: format + lint + typecheck + coverage + e2e + demo showcase |
| `pnpm demo` | builds the package, validates + indexes the demo vault, runs `apps/demo/src/app.js` |
| `pnpm typecheck` | runs `tsc --noEmit` across all packages |

---

## Quality Gates

Before finishing and handing over any task, run the relevant quality gates and report the result. Default to the full gate:

```bash
pnpm check
```

`pnpm check` must include, when available:

1. Formatting verification (`pnpm format:check`)
2. Linting (`pnpm lint`)
3. Type checking (`pnpm typecheck`)
4. Automated tests with meaningful coverage (`pnpm test:coverage`)
5. Package/e2e verification (`pnpm test:e2e`)
6. Demo or showcase validation (`pnpm --filter @madebywild/semantic-layer-demo showcase`)

If a task is too narrow for the full gate, run the smallest defensible subset and state what was skipped and why. If formatting or linting is missing in the repo, add Biome at the workspace root, define `format`, `format:check`, and `lint` scripts, and include them in `pnpm check` before handoff.

---

## packages/semantic-layer

### Source files

| File | Purpose |
| --- | --- |
| `src/types.ts` | all shared TypeScript types |
| `src/config.ts` | config loading (file discovery, merging, CLI overrides) |
| `src/vault.ts` | reads `.md` and `.schema.yml` files from the vault directory |
| `src/check.ts` | runs all validation rules, returns `CheckResult` |
| `src/index-vault.ts` | generates `HIERARCHY.md` from vault notes |
| `src/init.ts` | scaffolds a new vault + config file |
| `src/cli.ts` | CLI entry (`check`, `index`, `init`, `help`, `--version`) |
| `src/index.ts` | public API exports |
| `bin/semantic-layer.cjs` | thin CJS wrapper that `import()`s `dist/cli.js` |

Build: `tsup src/index.ts src/cli.ts --format esm --dts --clean --sourcemap`

Published files: `bin/`, `dist/`, `README.md`, `package.json`.

Dependencies: `gray-matter` (frontmatter parsing), `yaml` (schema/config parsing), `zod` (frontmatter validation schema).

---

### Core types (`src/types.ts`)

```ts
type Status = "draft" | "active" | "deprecated"

type CodeRef = { file: string; symbol: string }

type NoteFrontmatter = {
  id: string          // must match filename without .md
  title: string
  desc: string
  status: Status
  owner: string
  last_verified: string | Date
  ttl_days: number    // days until freshness expires
  audience?: string[]
  code_refs?: CodeRef[]
  tags?: string[]
} & Record<string, unknown>  // allows extra configured fields

type Note = {
  id: string
  file: string       // absolute path
  fm: NoteFrontmatter
  body: string       // markdown body (no frontmatter)
  headings: Set<string>  // slugified heading values
}

type SchemaDoc = {
  version: number
  schemas: Array<{
    id: string
    title?: string
    desc?: string
    parent?: string
    children?: string[]   // required child ids (without prefix)
    pattern?: string
    namespace?: boolean   // true = open schema, arbitrary children allowed
    template?: string
  }>
}

type ExternalInvariant = {
  id: string        // token name
  value: string     // expected value
  usedIn: string[]  // note ids that must contain both the token named by id and value
}

type SemanticLayerConfig = {
  vault: string
  root: string
  index: { file: string }
  frontmatter: { requiredExtraFields: string[] }
  externalInvariants: ExternalInvariant[]
}

type ResolvedConfig = SemanticLayerConfig & {
  configFile?: string
  repoRoot: string   // absolute path
  vaultDir: string   // absolute path
}

type CheckResult = { errors: string[]; noteCount: number }
```

---

### Config loading (`src/config.ts`)

Resolution order: CLI flags > config file > defaults.

Config files searched (in order): `semantic-layer.config.yml`, `semantic-layer.config.yaml`, `semantic-layer.config.json`.

Defaults:

```yaml
vault: vault
root: .
index:
  file: HIERARCHY.md
frontmatter:
  requiredExtraFields: []
externalInvariants: []
```

`repoRoot` and `vaultDir` on `ResolvedConfig` are always absolute, resolved relative to the config file's directory (or `cwd` if no config file).

---

### Vault reading (`src/vault.ts`)

`readVault(vaultDir)` scans the vault directory (flat, non-recursive) and returns `{ notes: Map<string, Note>, schemas: Map<string, SchemaDoc> }`.

- Skips `HIERARCHY.md`
- `.schema.yml` / `.schema.yaml` files are parsed as `SchemaDoc` and keyed by the part before `.schema.`
- `.md` files are parsed with `gray-matter`; headings are extracted and slugified via `slug()`

`slug(value)`: lowercases, strips non-alphanumeric-non-space-non-hyphen, trims, replaces spaces with `-`.

`toIsoDate(value)`: converts `Date` to `YYYY-MM-DD` string, passes strings through.

---

### Validation rules (`src/check.ts`)

`runCheck(options)` loads config then calls `checkResolved(config)`.

All checks run in this order:

1. **Vault exists** - fails immediately if `vaultDir` is missing.

2. **Root note** - vault must contain `root.md`.

3. **Frontmatter schema** (per note) - validated with Zod. Required fields: `id`, `title`, `desc`, `status` (enum), `owner`, `last_verified`, `ttl_days`. Invalid notes are excluded from further checks.

4. **id/filename match** - `fm.id` must equal the note's filename id.

5. **Extra required fields** - any field in `config.frontmatter.requiredExtraFields` must be present and non-empty.

6. **Hierarchy** - for every note id like `a.b.c`, ancestor notes `a.md` and `a.b.md` must exist. `root` is exempt.

7. **Schemas** - for each `*.schema.yml`:
   - Must have at least one schema entry with id matching the top-level name.
   - If `namespace: true` is absent (closed schema), all direct children of that namespace must be listed in `children`.
   - Every id listed in `children` must have a corresponding note.

8. **Wikilinks** - scans note bodies for `[[target]]` and `[[label|target]]` and `[[target#Heading]]`. Code fences and inline code are blanked before scanning. Checks that the target note exists and (if a heading is given) that the slugified heading exists in that note.

9. **Code refs** - for each `code_refs` entry: file must exist within `repoRoot` (path traversal blocked), and the source file must contain a declaration of the named symbol. Detection regex matches `function`, `class`, `const`, `let`, `var`, `interface`, `type`, `def` declarations with optional `export`, `export default`, `async` prefixes.

10. **Freshness** - skipped for `deprecated` notes. `last_verified + ttl_days` must be >= today (UTC). Reports how many days expired.

11. **External invariants** - for each invariant, each referenced note must contain the token named by the invariant `id` and the `value` string literally in its body.

---

### Index generation (`src/index-vault.ts`)

`runIndex(options)` writes `vault/HIERARCHY.md`. Notes are sorted: `root` first, then alphabetical by id. Depth is derived from dot-count. Returns `{ outFile, noteCount }`.

---

### Scaffold (`src/init.ts`)

`runInit(options)` creates: `semantic-layer.config.yml`, `vault/root.md`, `vault/meta.md`, `vault/meta.agent-conventions.md`, `vault/root.schema.yml`, `vault/meta.schema.yml`. Refuses to overwrite existing files.

---

### Programmatic API

```ts
import { loadConfig, runCheck, runIndex, runInit } from "@madebywild/semantic-layer"

// Run check
const result = runCheck({ cwd: process.cwd() })
if (result.errors.length > 0) throw new Error(result.errors.join("\n"))

// Run index
runIndex()

// Scaffold
runInit({ vault: "vault", owner: "eng@example.com" })
```

All three accept `LoadConfigOptions`: `{ cwd?, configPath?, vault?, root? }`.

---

## apps/demo

Consumer app that proves the package works outside its own source tree.

- `semantic-layer.config.yml` — uses `requiredExtraFields: [layer]` and one external invariant (`runtime` / `Node.js 24`, used in `demo.runtime`).
- `vault/` — five notes: `root`, `meta`, `meta.agent-conventions`, `demo`, `demo.runtime`. `demo.runtime` has a `code_ref` pointing to `src/app.js#runtimeName`.
- `src/app.js` — exports `describeSemanticLayer()` and `runtimeName()`; runnable as a script.
- `showcase` script: `pnpm docs:check && pnpm docs:index && node src/app.js`

---

## tests

`tests/e2e/semantic-layer.blackbox.test.ts` — Vitest test with a 3-minute timeout (Docker startup).

Flow:
1. `pnpm pack` the package into `.tmp/e2e/pack/`
2. Build a synthetic consumer project in `.tmp/e2e/consumer/`: `package.json` referencing the `.tgz`, a `semantic-layer.config.yml`, `src/service.js` (with `issueToken` export), and a vault with three notes + two schema files.
3. Start a `node:24-alpine` container via Testcontainers, copy the consumer into `/workspace`.
4. Run `npm install`, `npx semantic-layer --help`, `npx semantic-layer check`, `npx semantic-layer index` inside the container, asserting exit codes and output.
5. Mutate `service.auth.md` to use a bad symbol, assert `check` exits non-zero with the right error.

The `.tmp/` directory is created and destroyed by the test; it is git-ignored.

Unit tests live under `tests/unit/`. Integration tests live under `tests/integration/` and import the source public API rather than built `dist`, so they do not race the e2e packaging build. The e2e test remains the publish-path proof: it packs the package and installs the tarball into a clean consumer container.

---

## Development guide

### Adding a new validation rule

1. Add the check function to `src/check.ts` (follow the existing `check*` pattern — accept `notes`, `fail` callback, and whatever else is needed from `config`).
2. Call it inside `checkResolved()` after the existing calls.
3. Add a case to the e2e test's synthetic vault to trigger and verify the new error.
4. Update `packages/semantic-layer/README.md` under "Validation Rules".

### Adding a new config field

1. Add the field to `SemanticLayerConfig` in `src/types.ts`.
2. Set a default in `DEFAULT_CONFIG` in `src/config.ts`.
3. Merge it in `mergeConfig()`.
4. Use it in `checkResolved()` or wherever needed.

### Adding a new CLI command

1. Add the `runX` function (and its options type) in a new `src/x.ts` file.
2. Export it from `src/index.ts`.
3. Add the branch in `src/cli.ts` with help text in the `help()` function.
4. Add the tsup entry point if it needs a separate bundle (unlikely — the CLI is one file).

### TypeScript

- `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` — all imports inside `src/` must use `.js` extensions.
- `"noUncheckedIndexedAccess": true` — array/map index access returns `T | undefined`; always handle.
- `"strict": true` — no implicit any, strict null checks, etc.
- `"ignoreDeprecations": "6.0"` — suppresses TypeScript 6 deprecation noise.

### Testing and quality gates

`pnpm test` runs all Vitest projects from the repo root. The e2e suite requires Docker. Unit, integration, and e2e projects have separate Vitest project configs under `tests/*/vitest.config.ts`.

To run only source-level tests with coverage:

```bash
pnpm test:coverage
```

To run only the e2e suite:

```bash
pnpm test:e2e
```

Always run `pnpm check` before final handoff unless there is a clear blocker; if blocked, report the exact command and failure.

### Building

`pnpm build` runs `pnpm -r build` (all packages). The package build is `tsup src/index.ts src/cli.ts --format esm --dts --clean --sourcemap`. The `bin/semantic-layer.cjs` wrapper is static and not rebuilt.
