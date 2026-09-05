# @madebywild/semantic-layer migrations

## 2.2.0 (unreleased)

`2.2.0` adds a document-vector cache to `index`. No exported API changes, and
no config or vault change is required. The version is not bumped yet: the
release gates (`pnpm check` and `pnpm check:release`) belong to the release
commit.

### Vectors are reused across worktrees

`index` now stores each document vector in a small SQLite cache and reads it
back whenever the same text is embedded again. The cache file is
`<repo>/.git/semantic-layer/embeddings.sqlite`, which every linked worktree of
a repository resolves to, so a new worktree builds its index without a full
embedding pass. Outside a git repository the file falls back to the vault's own
`.semantic-layer/embeddings.sqlite`.

A cache entry is keyed by the embedder id, the dimensions, and the text, so a
changed note, changed chunking, or a changed model misses and recomputes. The
built index is unchanged: on a 1049-chunk vault every stored vector is
byte-identical to a build with no cache.

Consumer actions:

- None required. The file sits inside the git directory, thus no ignore rule
  applies to it, and the vault fallback is already covered by an ignore rule for
  `**/.semantic-layer/`.
- Set `SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE=1` to switch the cache off, for
  example to measure a cold build.

Entries that no build used for 30 days are removed when the embedder closes,
which bounds the file. Any store failure (a corrupt or unwritable file) degrades
to embedding without the cache instead of failing the build.

### New environment variables

- `SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE` — any non-empty value disables the
  document-vector cache described above.

## 2.1.0

`2.1.0` is a minor release: it adds a cross-process index lock and unifies
wikilink validation between `check` and `index`. No exported API is removed or
renamed, and existing vaults and configs keep working. Both changes alter
behavior in ways worth reading before upgrading.

### One index run per vault

Every path that writes derived state — `index`, `search-index`,
`refine promote`, the automatic build inside `search`, and corruption recovery —
now takes an exclusive lock file at `vault/.semantic-layer/index.lock`. A second
concurrent run fails immediately with an `IndexLockError` instead of racing:
previously two runs could interleave into `HIERARCHY.md` and `code-refs.json`,
or fail unpredictably with `SQLite WAL checkpoint did not fully drain`.

Consumer actions:

- Add `**/.semantic-layer/index.lock` to any ignore file that already lists
  `**/.semantic-layer/vault.sqlite*`.
- Serialize CI jobs, git hooks, or agent hooks that ran `index` in parallel on
  the same vault; `Promise.all([indexResolved(config), indexResolved(config)])`
  now rejects one branch instead of serializing silently.

Read-only `search` and `graph` are unaffected and still run during an index
build. A lock left behind by a killed run is reclaimed on the next run when its
pid is gone and it was recorded on the same host; a lock from another host must
be removed by hand. The `2.0.0` note below advised running only one full v2
index build per vault at a time; that is now enforced.

### Unified wikilink validation

Wikilink extraction and validation now share one parser. Both `check` and
`index` reject dangling notes, missing or ambiguous headings, multiple pipes,
and empty target/heading segments before graph state is written. Anchor-only
links such as `[[#Setup]]` resolve against their source note, nested heading
paths honor every `#` segment, repeated semantic links produce one edge, and
heading identity preserves punctuation and Unicode rather than validating via
a lossy slug.

The existing Dendron `[[alias|target]]` order remains the default, matching the
package's documented Dendron-style format without changing existing vaults.
Set the following for an Obsidian-authored `[[target|alias]]` vault:

```yaml
wikilinks:
  aliasOrder: obsidian
```

The alias order is stored in SQLite index metadata. Changing it makes the
derived index stale and triggers a full rebuild; no manual database migration
is necessary. Graph `anchor` results now contain the shortest exact heading
path that uniquely identifies the destination instead of a punctuation-losing
slug.

## 2.0.0

`2.0.0` replaces the LadybugDB index with Node's built-in `node:sqlite` and a
single derived SQLite file. This is a breaking major release for the supported
Node version and for low-level index result/lifecycle APIs; vault note format,
`search` modes, filters, and graph CLI semantics remain compatible.

### Required runtime

Run Node `>=22.16.0` (or Node 24). Although `node:sqlite` appears in earlier
Node 22 releases, the official Node 22.13 build does not include SQLite FTS5,
which this index requires. The package declares this through `engines.node`;
npm warns by default, so enable `engine-strict` in CI if an incompatible runtime
must fail at install time.

### Recommended rollout and rollback

1. Upgrade development, CI, and production runtimes while still on v1.1.0.
   Node 24 is the simplest common target.
2. Upgrade `@madebywild/semantic-layer` to v2 and remove any direct
   `@ladybugdb/core` dependency or Ladybug-specific bundler/native-package
   configuration.
3. Apply the library/JSON field changes below and compile the consumer before
   rebuilding any vault.
4. On one canary vault, run `semantic-layer check`, then
   `semantic-layer index --full`. The latter creates
   `vault/.semantic-layer/vault.sqlite`, containing the graph/search tables and
   index metadata in one database.
5. Verify representative `search --mode fts`, vector/hybrid search when the
   embedder is available, and graph commands before rolling out other vaults.
   Run only one full v2 index build per vault at a time.
6. Keep existing `vault/.semantic-layer/vault.lbug*` files through the rollback
   window. v2 deliberately never deletes or mutates them, so rollback is:
   repin v1.1.0, restore its Node/runtime deployment if necessary, and use the
   existing Ladybug index. No SQLite-to-Ladybug data conversion is required.
7. Remove `vault.lbug*` manually only after the v2 index has been accepted.
   The first successful migration emits a one-time message that the files are
   derived and safe to remove.

### Generated files and ignore rules

Keep both generations ignored during the rollback window. Add these rules to
custom ignore files:

```gitignore
**/.semantic-layer/vault.sqlite
**/.semantic-layer/vault.sqlite-wal
**/.semantic-layer/vault.sqlite-shm
**/.semantic-layer/vault.sqlite*.corrupt-*
**/.semantic-layer/vault.lbug*
```

WAL and SHM files are transient SQLite sidecars, not separate durable metadata.
`vault.sqlite*.corrupt-*` files are quarantined derived state; keep them for
diagnosis or remove them after a successful rebuild.

### Library and `--json` field migration

`BuildIndexResult` now exposes only `{ indexPath }`; metadata is stored in
SQLite rather than a `.meta.json` sidecar. `runIndex()` and
`semantic-layer index --json` use the same new layout:

| v1.1 field/API | v2 replacement |
| --- | --- |
| `result.db?.dbFile` | `result.db?.indexPath` |
| `result.db?.metaFile` | Removed; metadata is inside `vault.sqlite` |
| `result.db?.mode` | `result.build?.mode` |
| `result.db?.ftsOnly` | `result.build?.ftsOnly` |
| `result.db?.notesIndexed` / `notesRemoved` | `result.build?.notesIndexed` / `notesRemoved` |
| `result.db?.noteCount` / `chunkCount` | `result.build?.noteCount` / `chunkCount` |
| `closePooledDatabases()` | Remove the call; SQLite lifecycle is process-managed |
| `connection: LadybugConnection` test seam | Remove it; public index commands manage SQLite internally |

Before:

```ts
import { closePooledDatabases, runIndex } from "@madebywild/semantic-layer";

const result = await runIndex({ cwd: process.cwd() });
console.log(result.db?.dbFile, result.db?.mode);
await closePooledDatabases();
```

After:

```ts
import { runIndex } from "@madebywild/semantic-layer";

const result = await runIndex({ cwd: process.cwd() });
console.log(result.db?.indexPath, result.build?.mode);
```

The SQLite pool closes its current handle when switching index paths and at
process exit. If a test previously called `closePooledDatabases()` so it could
delete the active vault directory, isolate that indexed-vault test in a child
process (or set `search.enabled: false` when the test does not exercise search)
and remove the directory after that process exits.

### Operational changes

- `search.enabled: false` remains database-free: `index` writes only
  `HIERARCHY.md` and `code-refs.json`.
- FTS uses SQLite FTS5 maintained by triggers. Vectors are Float32 BLOBs and
  vector/hybrid mode performs exact cosine retrieval from the process cache.
- Physical corruption of this derived database is recoverable: artifacts are
  quarantined and a full rebuild runs. Do not restore the former metadata
  sidecar; it is no longer read.

## 1.0.0

Adds a local [LadybugDB](https://ladybugdb.com)-backed vault index (search +
graph queries) and makes `semantic-layer index` build it. The index lives in a
single `vault/.semantic-layer/vault.lbug` file. This is a **breaking change**
for the CLI behavior of `index` and for parts of the library API; vaults and
configs themselves keep working.

> Note: an intermediate, never-released Orama-based search index existed on
> the `feature/search-index` branch. If you only used released versions, none
> of the Orama file/config/API references below apply to you. If you did build
> from that branch, delete `vault/.semantic-layer/search-index.msp*` and
> `search-index.manifest.json*` (and their `.gitignore` entries), and note the
> `search.indexFile`/`search.manifestFile` config keys are gone (silently
> ignored, not rejected).

### Breaking changes

- `semantic-layer index` now builds the LadybugDB vault index in addition to
  `HIERARCHY.md` and `code-refs.json`. With `search.enabled: false` it writes
  only the two sidecars and does not touch the database (and never loads the
  native module).
- `search-index` is an alias for `index`.
- The database path is fixed at `vault/.semantic-layer/vault.lbug` and its
  metadata sidecar is `vault/.semantic-layer/vault.lbug.meta.json`.
- New generated files (gitignored):
  - `vault/.semantic-layer/vault.lbug`
  - `vault/.semantic-layer/vault.lbug.meta.json`

### Library API breaking changes

- `runIndex` / `indexResolved` are now async and return
  `{ db, outFile, codeRefsFile, noteCount }` (`db` is undefined when
  `search.enabled` is false). They accept an optional `embedder` for tests.
- `runRefinementPromote` is now async.
- New exports: `runSearch(options)` (returns `{ mode, hits, stale, rebuilt }`)
  and `runGraph(options)`, plus `BuildIndexResult` and the `graph` result
  types.
- Database lifecycle: the LadybugDB handle is pooled per process and stays
  open (WAL-drained after every command) instead of being closed after each
  call. LadybugDB 0.18.2 cannot safely close-then-reopen the same database
  path within one process — the close leaves native background state that can
  corrupt the next open's FTS index build — so repeated `runIndex`/`runSearch`
  calls in one process now share one handle. Everything is closed in a
  process-exit hook; long-lived embedders that need to release the database
  earlier (e.g. before deleting the vault directory) can await the new async
  `closePooledDatabases()` export — it waits for queued work before closing —
  but must not reopen the same path from the same process afterwards. Database work is serialized per process (LadybugDB
  allows one write transaction system-wide), so concurrent `runIndex` /
  `runSearch` / `runGraph` calls queue instead of failing.
- Platform requirement: `@ladybugdb/core` is a native module that needs
  glibc + OpenSSL 3. `check`, `init`, and `refine stage|list|reject` load no
  native code and work anywhere; `index` (unless `search.enabled: false`),
  `search`, `graph`, and `refine promote` require a supported platform.

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

### New generated files (gitignored)

- `vault/.semantic-layer/vault.lbug`
- `vault/.semantic-layer/vault.lbug.meta.json`
- `vault/.semantic-layer/vault.lbug.wal` (transient WAL)

If you maintain your own `.gitignore`, add:

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
    provider: local
  defaultMode: hybrid
  defaultLimit: 10
```

### New / changed dependencies

`@ladybugdb/core` is a new runtime dependency. `@huggingface/transformers`
(transformers.js, ONNX Runtime backend) is an optional dependency for local
embeddings; the default local model is `nomic-ai/nomic-embed-text-v1.5`,
Matryoshka-truncated to 512 dimensions.

### New environment variables

- `SEMANTIC_LAYER_MODEL_CACHE_DIR` — overrides where the local embedding
  model is cached (default `$XDG_CACHE_HOME/semantic-layer/models`, or
  `~/.cache/semantic-layer/models` when `XDG_CACHE_HOME` is unset).
- `SEMANTIC_LAYER_GEMINI_API_KEY` (falls back to `GEMINI_API_KEY`) — API key
  for the optional hosted `gemini` embedding provider.

### Alpine / musl

LadybugDB itself is a native module and requires glibc + OpenSSL 3, so on
`node:*-alpine` or similar only the non-database commands work: `check`,
`init`, and `refine stage|list|reject`. `index`, `search`, `graph`, and
`refine promote` need a glibc-based image. Independently, the local embedding
runtime (`onnxruntime-node`, via `@huggingface/transformers`) has no musl
build either — on platforms where its native bindings fail to load, `index`
degrades to an FTS-only index instead of failing (`search --mode fts` keeps
working; `--mode vector`/`--mode hybrid` fail with an actionable message), or
set `search.embedding.provider: gemini`.

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
