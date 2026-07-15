#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCheck } from "./check.js";
import { runIndex } from "./index-vault.js";
import { runInit } from "./init.js";
import {
  runRefinementList,
  runRefinementPromote,
  runRefinementReject,
  runRefinementStage,
} from "./refinements.js";
import { runSearchBuild } from "./search/build.js";
import { runSearchQuery, type SearchQueryResult } from "./search/query.js";
import type { RefinementStatus, SearchMode } from "./types.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    audience: { type: "string", multiple: true },
    config: { type: "string" },
    evidence: { type: "string", multiple: true },
    full: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    limit: { type: "string" },
    mode: { type: "string" },
    note: { type: "string", multiple: true },
    owner: { type: "string" },
    reason: { type: "string" },
    rebuild: { type: "boolean" },
    related: { type: "string", multiple: true },
    root: { type: "string" },
    source: { type: "string" },
    status: { type: "string" },
    stdin: { type: "boolean" },
    summary: { type: "string" },
    tag: { type: "string", multiple: true },
    title: { type: "string" },
    vault: { type: "string" },
    version: { type: "boolean" },
  },
});

const [command, helpCommand, targetId] = positionals;
const activeCommand = command ?? "check";

try {
  if (values.version) {
    console.log(getVersion());
    process.exit(0);
  }

  if (values.help || activeCommand === "help") {
    console.log(help(activeCommand === "help" ? helpCommand : command));
    process.exit(0);
  }

  if (activeCommand === "check") {
    const result = runCheck({
      configPath: values.config,
      root: values.root,
      vault: values.vault,
    });
    if (result.errors.length === 0) {
      console.log(`semantic-layer: ok (${result.noteCount} notes verified)`);
      process.exit(0);
    }
    console.error(`semantic-layer: ${result.errors.length} problem(s)\n`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  if (activeCommand === "index") {
    const result = runIndex({
      configPath: values.config,
      root: values.root,
      vault: values.vault,
    });
    console.log(
      `semantic-layer index: wrote ${result.outFile} and ${result.codeRefsFile} (${result.noteCount} notes)`,
    );
    process.exit(0);
  }

  if (activeCommand === "init") {
    const result = runInit({ owner: values.owner, vault: values.vault });
    console.log(`semantic-layer init: scaffolded ${result.vaultDir}`);
    process.exit(0);
  }

  if (activeCommand === "refine") {
    runRefine(helpCommand, targetId);
    process.exit(0);
  }

  if (activeCommand === "search-index") {
    // Deliberately no process.exit() below this point: once the fastembed provider has loaded
    // its native ONNX session, forcing an abrupt exit crashes the process (a native mutex error
    // during teardown) even though the command itself succeeded. Setting exitCode and letting
    // the event loop drain naturally avoids that crash and still reports the right status.
    const result = await runSearchBuild({
      configPath: values.config,
      root: values.root,
      vault: values.vault,
      full: values.full,
    });
    const mode = result.ftsOnly ? `${result.mode} (fts-only)` : result.mode;
    console.log(
      `semantic-layer search-index: ${mode} rebuild — ${result.notesIndexed} changed, ` +
        `${result.notesRemoved} removed, ${result.noteCount} notes, ${result.chunkCount} chunks ` +
        `(${result.indexFile})`,
    );
    process.exitCode = 0;
  } else if (activeCommand === "search") {
    const query = positionals.slice(1).join(" ").trim();
    if (!query) {
      throw new Error(
        'semantic-layer search requires a query, e.g. semantic-layer search "runtime"',
      );
    }
    const result = await runSearchQuery({
      configPath: values.config,
      root: values.root,
      vault: values.vault,
      query,
      mode: parseSearchMode(values.mode),
      limit: parseLimit(values.limit),
      status: values.status,
      tags: values.tag ?? [],
      audience: values.audience ?? [],
      rebuild: values.rebuild,
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSearchResults(result);
    }
    process.exitCode = 0;
  } else {
    console.error(
      `Unknown command: ${activeCommand}. Use check, index, init, refine, search-index, search, or help.`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Same reasoning as above: avoid process.exit() here too, since search/search-index can throw
  // after fastembed's native session is already loaded.
  process.exitCode = 1;
}

function getVersion() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function help(command: string | undefined) {
  if (command === "check") {
    return `Usage: semantic-layer check [options]

Validate a Dendron-style vault.

Options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  -h, --help       Show help
`;
  }

  if (command === "index") {
    return `Usage: semantic-layer index [options]

Regenerate the agent-facing hierarchy index and code refs sidecar.

Options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  -h, --help       Show help
`;
  }

  if (command === "init") {
    return `Usage: semantic-layer init [options]

Scaffold a new vault and semantic-layer.config.yml.

Options:
  --vault <path>   Vault directory to create (default: vault)
  --owner <value>  Owner value for generated frontmatter
  -h, --help       Show help
`;
  }

  if (command === "refine") {
    return `Usage: semantic-layer refine <subcommand> [options]

Manage evolutionary self-improvement refinement candidates.

Subcommands:
  stage      Stage a distilled non-assistant project signal
  list       List staged, promoted, or rejected refinements
  promote    Mark a staged refinement promoted after vault updates pass checks
  reject     Reject a staged refinement with a reason

Examples:
  semantic-layer refine stage --source user-message --title "Runtime changed" --stdin
  semantic-layer refine list --status staged
  semantic-layer refine promote <id> --note demo.runtime
  semantic-layer refine reject <id> --reason "Superseded"

Options:
  --config <path>    Config file path
  --vault <path>     Vault directory override
  --root <path>      Repo root override for code_refs
  --source <value>   Source label for staged refinements
  --title <value>    Short staged refinement title
  --summary <value>  Distilled staged refinement summary
  --stdin            Read staged refinement summary from stdin
  --related <id>     Related note id; may be repeated
  --evidence <text>  Evidence snippet; may be repeated
  --status <value>   staged, promoted, rejected, or all
  --note <id>        Promoted note id; may be repeated
  --reason <value>   Rejection reason
  -h, --help         Show help
`;
  }

  if (command === "search-index") {
    return `Usage: semantic-layer search-index [options]

Build or incrementally refresh the local vault search index (full-text + vector).

Options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  --full           Force a full rebuild instead of an incremental one
  -h, --help       Show help
`;
  }

  if (command === "search") {
    return `Usage: semantic-layer search "<query>" [options]

Search the local vault search index. Builds the index first if it doesn't exist yet.

Options:
  --config <path>     Config file path
  --vault <path>      Vault directory override
  --root <path>       Repo root override for code_refs
  --mode <value>      fts, vector, or hybrid (default from config)
  --limit <n>         Maximum number of results (default from config)
  --status <value>    Filter to notes with this status
  --tag <value>       Filter to notes with this tag; may be repeated
  --audience <value>  Filter to notes with this audience; may be repeated
  --json              Print results as JSON
  --rebuild           Refresh the index before searching
  -h, --help          Show help
`;
  }

  return `Usage: semantic-layer <command> [options]

Commands:
  check         Validate a vault (default)
  index         Regenerate vault/HIERARCHY.md and code refs sidecar
  init          Scaffold a new vault
  refine        Manage staged evolutionary refinements
  search-index  Build or refresh the local vault search index
  search        Search the local vault search index
  help          Show help

Global options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  --version        Print package version
  -h, --help       Show help
`;
}

function runRefine(subcommand: string | undefined, id: string | undefined) {
  const loadOptions = {
    configPath: values.config,
    root: values.root,
    vault: values.vault,
  };

  if (subcommand === "stage") {
    const summary = values.stdin
      ? readFileSync(0, "utf8")
      : requiredString(values.summary, "--summary");
    const result = runRefinementStage({
      ...loadOptions,
      source: requiredString(values.source, "--source"),
      title: requiredString(values.title, "--title"),
      summary,
      evidence: stringList(values.evidence),
      relatedNotes: stringList(values.related),
    });
    console.log(`semantic-layer refine: staged ${result.refinement.id}`);
    return;
  }

  if (subcommand === "list") {
    const result = runRefinementList({ ...loadOptions, status: parseStatus(values.status) });
    if (result.errors.length > 0) {
      throw new Error(`refinement metadata validation failed:\n${result.errors.join("\n")}`);
    }
    if (result.refinements.length === 0) {
      console.log("semantic-layer refine: no refinements");
      return;
    }
    for (const refinement of result.refinements) {
      console.log(`- ${refinement.id} [${refinement.status}] ${refinement.title}`);
    }
    return;
  }

  if (subcommand === "promote") {
    const result = runRefinementPromote({
      ...loadOptions,
      id: requiredString(id, "refinement id"),
      notes: stringList(values.note),
    });
    console.log(
      `semantic-layer refine: promoted ${result.refinement.id} and wrote ${result.indexFile}`,
    );
    return;
  }

  if (subcommand === "reject") {
    const result = runRefinementReject({
      ...loadOptions,
      id: requiredString(id, "refinement id"),
      reason: requiredString(values.reason, "--reason"),
    });
    console.log(`semantic-layer refine: rejected ${result.refinement.id}`);
    return;
  }

  throw new Error("Unknown refine subcommand. Use stage, list, promote, reject, or help.");
}

function requiredString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function stringList(value: string[] | undefined): string[] {
  return value ?? [];
}

function parseStatus(value: string | undefined): RefinementStatus | "all" | undefined {
  if (!value) return undefined;
  if (value === "staged" || value === "promoted" || value === "rejected" || value === "all") {
    return value;
  }
  throw new Error("--status must be staged, promoted, rejected, or all");
}

function parseSearchMode(value: string | undefined): SearchMode | undefined {
  if (!value) return undefined;
  if (value === "fts" || value === "vector" || value === "hybrid") return value;
  throw new Error("--mode must be fts, vector, or hybrid");
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("--limit must be a positive integer");
  return parsed;
}

function printSearchResults(result: SearchQueryResult) {
  if (result.hits.length === 0) {
    console.log("semantic-layer search: no results");
    return;
  }
  for (const hit of result.hits) {
    const heading = hit.headingPath ? ` > ${hit.headingPath}` : "";
    console.log(`- [${hit.score.toFixed(3)}] ${hit.id} (${hit.status}) ${hit.title}${heading}`);
    console.log(`  ${truncate(hit.text, 160)}`);
  }
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}
