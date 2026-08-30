---
id: meta.indexing
title: Index concurrency
desc: One index writer per vault, enforced by a cross-process lock file.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-08-30
ttl_days: 180
tags: [meta, indexing]
layer: demo
code_refs:
  - file: packages/semantic-layer/src/index-lock.ts
    symbol: withIndexLock
    kind: function
  - file: packages/semantic-layer/src/index-lock.ts
    symbol: IndexLockError
    kind: class
---

# Index concurrency

Only one index run per vault may write at a time. Every path that rebuilds
derived state takes an exclusive lock file at
`vault/.semantic-layer/index.lock` first: `index` and its `search-index` alias,
`refine promote`, the automatic build inside `search` (cold start or
`--rebuild`), and corruption recovery. Read-only `search` and `graph` never take
it, so agents can keep querying the vault described in [[meta.search]] while an
index run is in flight.

Acquisition never waits. A second concurrent run fails immediately with an
`IndexLockError` naming the holding pid, host, start time, and command, and the
CLI exits 1. Because nothing ever blocks on the lock, it cannot form a wait
cycle with SQLite's own busy timeout no matter which is taken first.

The lock file records `pid`, `hostname`, `startedAt`, and `command`. A lock left
behind by a killed run is reclaimed on the next run when its pid is no longer
running (including a Linux zombie awaiting reaping) and it was written on the
same host; a lock recorded on another host or in another container's pid
namespace is never reclaimed automatically, because its pid means nothing
locally, and has to be deleted by hand. The file is gitignored alongside
`vault.sqlite`.

What the lock does not cover: a long-lived reader in another process can still
make an index run's `wal_checkpoint(TRUNCATE)` report a busy WAL. Only
writer-versus-writer races are eliminated. Contention coverage and stale
reclaim are exercised at every test layer described in [[meta.testing]].
