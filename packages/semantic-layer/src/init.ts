import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type InitOptions = {
  cwd?: string;
  vault?: string;
  owner?: string;
};

export function runInit(options: InitOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const vault = options.vault ?? "vault";
  const vaultDir = resolve(cwd, vault);
  const owner = options.owner ?? process.env.USER ?? "you@example.com";
  const today = new Date().toISOString().slice(0, 10);

  mkdirSync(vaultDir, { recursive: true });
  writeNew(join(cwd, "semantic-layer.config.yml"), config(vault));
  writeNew(join(vaultDir, "root.md"), rootNote(owner, today));
  writeNew(join(vaultDir, "meta.md"), metaNote(owner, today));
  writeNew(join(vaultDir, "meta.agent-conventions.md"), conventionsNote(owner, today));
  writeNew(join(vaultDir, "root.schema.yml"), rootSchema());
  writeNew(join(vaultDir, "meta.schema.yml"), metaSchema());
  return { vaultDir };
}

function writeNew(file: string, body: string) {
  if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  writeFileSync(file, body);
}

function config(vault: string) {
  return `vault: ${vault}
root: .
index:
  file: HIERARCHY.md
frontmatter:
  requiredExtraFields: []
externalInvariants: []
evolution:
  stagingDir: ${vault}/.semantic-layer/refinements
`;
}

function rootNote(owner: string, today: string) {
  return `---
id: root
title: Docs root
desc: Entry point for the semantic documentation vault.
status: active
owner: ${owner}
audience: [agents, eng]
last_verified: ${today}
ttl_days: 365
tags: [meta]
---

# Docs root

Read [[meta.agent-conventions]] before changing this vault.
`;
}

function metaNote(owner: string, today: string) {
  return `---
id: meta
title: Metadata
desc: Operating notes for this vault.
status: active
owner: ${owner}
audience: [agents, eng]
last_verified: ${today}
ttl_days: 365
tags: [meta]
---

# Metadata

This namespace contains documentation conventions for agents and humans.
`;
}

function conventionsNote(owner: string, today: string) {
  return `---
id: meta.agent-conventions
title: Agent conventions
desc: How agents should read and update this vault.
status: active
owner: ${owner}
audience: [agents]
last_verified: ${today}
ttl_days: 365
tags: [meta, agents]
---

# Agent conventions

Read HIERARCHY.md first. Load only notes relevant to the task. After changing
notes, run semantic-layer check and semantic-layer index.

For evolutionary self-improvement, stage durable non-assistant project signals
with semantic-layer refine stage. Promote staged refinements only after updating
the trusted vault and passing semantic-layer check.
`;
}

function rootSchema() {
  return `version: 1
schemas:
  - id: root
    title: Root
    parent: root
    children: [meta]
`;
}

function metaSchema() {
  return `version: 1
schemas:
  - id: meta
    title: Metadata
    parent: root
    children: [agent-conventions]
`;
}
