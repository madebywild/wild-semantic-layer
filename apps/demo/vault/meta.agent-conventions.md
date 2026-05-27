---
id: meta.agent-conventions
title: Agent conventions
desc: How agents should work with this demo vault.
status: active
owner: tom@wild.as
audience: [agents]
last_verified: 2026-05-26
ttl_days: 365
tags: [meta, agents]
layer: demo
---

# Agent conventions

Read HIERARCHY.md first. Load only the notes needed for the task. Run
`semantic-layer check` and `semantic-layer index` after documentation changes.
Use [[meta.testing]] for package-level blackbox e2e coverage expectations.

For evolutionary self-improvement, stage durable non-assistant project signals
with `semantic-layer refine stage`. Promote staged refinements only after
updating the trusted vault and passing `semantic-layer check`.
