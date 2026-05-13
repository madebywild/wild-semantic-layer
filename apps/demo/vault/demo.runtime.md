---
id: demo.runtime
title: Runtime contract
desc: Runtime assumptions for the demo app.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-05-13
ttl_days: 90
code_refs:
  - file: src/app.js
    symbol: runtimeName
tags: [runtime]
layer: demo
---

# Runtime contract

The demo targets Node.js 24 and records that fact as {{runtime}} so invariant
drift is caught by `semantic-layer check`.
