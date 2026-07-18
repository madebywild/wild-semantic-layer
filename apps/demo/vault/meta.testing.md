---
id: meta.testing
title: Testing contract
desc: Test-suite layers and isolation guarantees for the semantic-layer package.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-07-18
ttl_days: 180
tags: [meta, testing]
layer: demo
---

# Testing contract

Four vitest projects cover the package, from fastest to most isolated:

- `unit` and `integration` run on the host against the TypeScript source.
- `integration-container` re-runs the whole integration project inside an
  isolated `node:24` Testcontainers container (Debian glibc — the platform
  LadybugDB actually ships to). It copies the repo in, installs with a frozen
  lockfile, and asserts the suite passes; the container is removed after the
  run (Testcontainers' Ryuk reaper covers crashes), so LadybugDB temp-file
  debris never accumulates on the host. It is not part of the default
  `pnpm check`: agents run it locally via `pnpm check:release` before cutting
  any release (patch, minor, or major), deliberately keeping it out of CI.
- `e2e` packs `@madebywild/semantic-layer` once, runs one `node:24`
  Testcontainers runtime, and exercises the published CLI in isolated
  consumer workspaces: a monorepo TypeScript service with custom code-ref
  sidecar output, a simple JavaScript consumer refinement lifecycle, and
  drift or migration failures that must not overwrite generated indexes.
  The container has no working local embedding runtime (onnxruntime-node),
  which doubles as coverage for the FTS-only degradation described in
  [[meta.search]].

LadybugDB 0.18.2 cannot safely close-then-reopen the same database path
within one process (the close leaves native background state that corrupts
the next FTS index build), so the library pools one open database handle per
process and drains the WAL after every unit of work. The connection tests pin
both behaviors; do not "fix" tests by adding close/reopen cycles.
