# System Prompt

You have full autonomy in this repository. Read, write, execute, and search as needed to complete the task. Prefer concrete progress over discussion, but keep changes scoped and explain blockers with the exact command or file involved.

## Project

`wild-semantic-layer` is a pnpm monorepo for `@madebywild/semantic-layer`, a Dendron-style semantic documentation validator and indexer. Documentation is treated like source code: vault notes must validate before they are trusted by agents.

Primary workspace areas:

- `packages/semantic-layer/`: reusable TypeScript library and CLI.
- `apps/demo/`: live consumer app with a real semantic-layer vault.
- `tests/unit/`: focused unit tests for rules and helpers.
- `tests/integration/`: source-level API workflow tests.
- `tests/integration-container/`: the integration suite re-run inside an isolated Linux (node:24) Testcontainers container for glibc parity.
- `tests/e2e/`: blackbox CLI/package-install tests using Testcontainers.

Use the repository's existing patterns and TypeScript settings. Source imports in `packages/semantic-layer/src/` use `.js` extensions because the package uses `module` and `moduleResolution` set to `NodeNext`.

## Semantic Layer Workflow

Pre task:

- If `vault/HIERARCHY.md` is missing or stale, run `semantic-layer index`.
- Read `vault/HIERARCHY.md` first, then open only the `vault/*.md` notes relevant to the task.
- Follow wikilinks and `code_refs` from relevant notes before changing code.

Post task:

- Create, update, or delete `vault/*.md` notes and `*.schema.yml` files for any behavior, API, architecture, or operational knowledge changed by the task.
- Keep frontmatter current, including `last_verified`, `ttl_days`, `code_refs`, wikilinks, schema children, and configured external invariants.
- Stage significant non-assistant inputs with `semantic-layer refine stage` when they may refine the graph but should not be trusted directly yet.
- Promote staged refinements only after updating the trusted vault, then reject shallow, faulty, secret-bearing, or obsolete staged inputs with a reason.
- Run `semantic-layer check` and `semantic-layer index`; do not hand off until both pass or the exact failures are reported.

## Harness Source Of Truth

All agent configuration must be authored exclusively inside `.harness/`.

This includes MCP servers, prompts, subagents, agent settings, agent lifecycle hooks, skills, provider overrides, and any related agent configuration. Do not edit generated provider files such as `AGENTS.md`, `CLAUDE.md`, `.codex/config.toml`, `.claude/settings.json`, Copilot instructions, or editor settings directly when the change belongs to agent configuration. Update the corresponding source under `.harness/` instead.

After every change related to MCP, prompts, subagents, agent settings, agent lifecycle hooks, skills, or provider configuration, run:

```bash
pnpm harness apply
```

Treat `pnpm harness apply` as a required gate for those changes. If it fails, fix the `.harness/` source or manifest and run it again before finishing.

## Quality Gates

Before handing off a task, run the relevant gates and report results. Routine changes do NOT run the full check suite. The minimum gates for every finished task, unless there is a clear blocker, are:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
```

plus the tests that cover the code you touched (run the smallest vitest scope that exercises the change, not the whole suite).

The full suites run only before a release — any version bump (patch, minor, or major) requires both, before the release tag is created:

```bash
pnpm check
pnpm check:release
```

`pnpm check` runs format/lint/typecheck, unit + integration with coverage, the e2e Testcontainers suite, and the demo showcase. `pnpm check:release` adds the containerized integration suite (`tests/integration-container/`, Linux/glibc parity via Testcontainers, requires Docker). The containerized suite stays local by design to save CI compute: do not add it to CI workflows, and do not fold it back into the default `pnpm check`. If Docker is unavailable, report that the release gate was skipped and why instead of silently proceeding.

Use the smallest defensible subset of the minimum gates only for narrow non-code changes, and state what was skipped and why. If a gate fails, report the exact command and the failure.
