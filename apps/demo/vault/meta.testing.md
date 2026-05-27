---
id: meta.testing
title: Testing contract
desc: Blackbox e2e coverage expectations for the semantic-layer package.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-05-26
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
