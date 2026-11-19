---
id: meta.testing
title: Testing contract
desc: Test-suite layers and isolation guarantees for the semantic-layer package.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-11-19
ttl_days: 180
tags: [meta, testing]
layer: demo
---

# Testing contract

Four vitest projects cover the package, from fastest to most isolated:

- `unit` and `integration` run on the host against the TypeScript source.
- `integration-container` re-runs the whole integration project inside
  isolated `node:22.16.0` and `node:24` Testcontainers containers. It copies
  the repo in, installs with a frozen lockfile, and asserts the suite passes;
  each container is
  removed after the run (Testcontainers' Ryuk reaper covers crashes), so index
  artifacts never accumulate on the host. It is not part of the default
  `pnpm check`: agents run it locally via `pnpm check:release` before cutting
  any release (patch, minor, or major), deliberately keeping it out of CI.
- `e2e` packs `@madebywild/semantic-layer` once, runs one `node:24`
  Testcontainers runtime, and exercises the published CLI in isolated
  consumer workspaces: a monorepo TypeScript service with custom code-ref
  sidecar output, a simple JavaScript consumer refinement lifecycle, and
  drift or migration failures that must not overwrite generated indexes.
  The container exercises Node's built-in SQLite and FTS5 on the supported
  Node 24 runtime. It also inspects the packed public declaration so internal
  SQLite connection types cannot leak into consumers that do not use indexing.
  Packed consumers install no model runtime at all; the static embedder
  downloads its model on first index, and the scenarios accept either a
  vector or an FTS-only build so they pass with or without network access.
  Vector behavior is covered by source-level integration tests, and the
  offline FTS-only fallback by `fts-only.test.ts`.

The package requires Node `>=22.16.0`: the built-in SQLite API is available in
Node 22, but official Node 22.13 builds do not include FTS5. Node 22.16+ and
Node 24 are the supported validation targets. SQLite state is one
`vault.sqlite` file, with transient WAL/SHM sidecars; tests may freely close
and reopen it. Integration coverage includes full and incremental indexing,
FTS-only fallback, metadata/config drift, filters and graph queries,
pre-transaction embedding failures, FTS integrity recovery, corruption
recovery (including rejection of message-only false positives), migration
that preserves and gitignores legacy `.lbug` artifacts, and index-lock
contention: a planted live holder must block `index`, `search --rebuild`, and
corruption recovery without touching generated files, while a lock left by a
killed process is reclaimed. See [[meta.indexing]].
