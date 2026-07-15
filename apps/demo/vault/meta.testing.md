---
id: meta.testing
title: Testing contract
desc: Blackbox e2e coverage expectations for the semantic-layer package.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-07-15
ttl_days: 180
tags: [meta, testing]
layer: demo
---

# Testing contract

The package blackbox e2e suite packs `@madebywild/semantic-layer` once, runs one
`node:24-alpine` Testcontainers runtime, and creates isolated consumer
workspaces for each scenario.

The focused scenarios cover a monorepo TypeScript service with custom code-ref
sidecar output, a simple JavaScript consumer refinement lifecycle, and drift or
migration failures that must not overwrite previously generated indexes.

A second, separate blackbox file covers [[meta.search]] on Alpine/musl: it
packs its own tarball and runs its own `node:24-alpine` container so it never
touches the suite above. It proves `search-index` degrades to an FTS-only
index (no crash) when the local embedder's native ONNX build is unavailable,
that FTS search and incremental rebuilds keep working in that state, and that
the `gemini` provider's code path runs cleanly on musl up to the point a real
API key would be required.
