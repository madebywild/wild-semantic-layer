---
id: demo
title: Demo application
desc: Live example of a consumer app using the semantic layer package.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-05-26
ttl_days: 180
tags: [demo]
layer: demo
---

# Demo application

The demo app proves the package works outside its own source tree. It links to
[[demo.runtime]], validates source symbols in `src/app.js`, and emits generated
symbol metadata at `.semantic-layer/code-refs.json` during indexing.
