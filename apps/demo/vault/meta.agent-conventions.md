---
id: meta.agent-conventions
title: Agent conventions
desc: How agents should work with this demo vault.
status: active
owner: tom@wild.as
audience: [agents]
last_verified: 2026-07-15
ttl_days: 365
tags: [meta, agents]
layer: demo
---

# Agent conventions

Read HIERARCHY.md first. Load only the notes needed for the task. Run
`semantic-layer check` and `semantic-layer index` after documentation changes.
Use [[meta.testing]] for package-level blackbox e2e coverage expectations. On a
larger vault, `semantic-layer search "<query>"` can help find relevant notes
before falling back to reading HIERARCHY.md in full; see [[meta.search]].

For evolutionary self-improvement, stage durable non-assistant project signals
with `semantic-layer refine stage`. Promote staged refinements only after
updating the trusted vault and passing `semantic-layer check`.
