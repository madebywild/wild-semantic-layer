#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCheck } from "./check.js";
import { runInit } from "./init.js";
import {
  runRefinementList,
  runRefinementPromote,
  runRefinementReject,
  runRefinementStage,
} from "./refinements.js";
import type { RefinementStatus, SearchMode } from "./types.js";

// DB-dependent commands are loaded lazily so that `check`, `init`,
// `refine stage|list|reject`, `--help`, and `--version` work even when
// LadybugDB's native module is unavailable (e.g. musl/Alpine Linux). The
// commands that need the DB will surface their own load error when invoked.

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    // global / shared
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
    root: { type: "string" },
    vault: { type: "string" },
    version: { type: "boolean" },
    json: { type: "boolean" },

    // index / search-index
    full: { type: "boolean" },

    // search
    mode: { type: "string" },
    limit: { type: "string" },
    status: { type: "string" },
    tag: { type: "string", multiple: true },
    audience: { type: "string", multiple: true },
    rebuild: { type: "boolean" },

    // graph
    depth: { type: "string" },
    file: { type: "string" },
    symbol: { type: "string" },

    // refine
    evidence: { type: "string", multiple: true },
    note: { type: "string", multiple: true },
    owner: { type: "string" },
    reason: { type: "string" },
    related: { type: "string", multiple: true },
    source: { type: "string" },
    stdin: { type: "boolean" },
    summary: { type: "string" },
    title: { type: "string" },
  },
});

const [command, subcommandOrQuery, positionalId] = positionals;
const activeCommand = command ?? "check";

try {
  if (values.version) {
    console.log(getVersion());
    process.exit(0);
  }

  if (values.help || activeCommand === "help") {
    console.log(help(activeCommand === "help" ? subcommandOrQuery : command));
    process.exit(0);
  }

  const loadOptions = {
    configPath: values.config,
    root: values.root,
    vault: values.vault,
  };

  if (activeCommand === "check") {
    const result = runCheck(loadOptions);
    if (values.json) {
      console.log(JSON.stringify(result));
    } else if (result.errors.length === 0) {
      console.log(`semantic-layer: ok (${result.noteCount} notes verified)`);
    } else {
      console.error(`semantic-layer: ${result.errors.length} problem(s)\n`);
      for (const error of result.errors) console.error(`  - ${error}`);
    }
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  } else if (activeCommand === "index" || activeCommand === "search-index") {
    const { runIndex } = await import("./commands/index.js");
    const result = await runIndex({
      ...loadOptions,
      full: values.full,
    });
    if (values.json) {
      console.log(JSON.stringify(result));
    } else if (!result.db) {
      console.log(
        `semantic-layer index: search disabled — wrote ${result.outFile}, ${result.codeRefsFile} ` +
          `(${result.noteCount} notes)`,
      );
    } else {
      const mode = result.db.ftsOnly ? `${result.db.mode} (fts-only)` : result.db.mode;
      console.log(
        `semantic-layer index: ${mode} rebuild — ${result.db.notesIndexed} indexed, ` +
          `${result.db.notesRemoved} removed, ${result.db.noteCount} notes, ${result.db.chunkCount} chunks ` +
          `(${result.db.dbFile}, ${result.outFile}, ${result.codeRefsFile})`,
      );
    }
    process.exitCode = 0;
  } else if (activeCommand === "search") {
    const query = subcommandOrQuery;
    if (!query) {
      console.error("semantic-layer search: <query> is required");
      process.exit(1);
    }
    const { runSearch } = await import("./commands/search.js");
    const result = await runSearch({
      ...loadOptions,
      query,
      mode: parseSearchMode(values.mode),
      limit: parseOptionalInt(values.limit, "--limit"),
      status: values.status,
      tags: stringList(values.tag),
      audience: stringList(values.audience),
      rebuild: values.rebuild,
    });
    if (values.json) {
      console.log(JSON.stringify(result));
    } else {
      if (result.rebuilt) {
        console.error("semantic-layer search: index rebuilt before query");
      }
      if (result.stale) {
        console.error("semantic-layer search: index is stale; results may be incomplete");
      }
      for (const hit of result.hits) {
        console.log(`${hit.score.toFixed(4)}\t${hit.noteId}\t${hit.title}\t${hit.headingPath}`);
      }
      console.log(`${result.hits.length} hit(s) for "${query}" (${result.mode})`);
    }
    process.exitCode = 0;
  } else if (activeCommand === "graph") {
    const subcommand = subcommandOrQuery;
    if (!subcommand) {
      console.error("semantic-layer graph: <subcommand> is required");
      process.exit(1);
    }
    const { runGraph } = await import("./commands/graph.js");
    const result = await runGraph({
      ...loadOptions,
      subcommand,
      noteId: positionalId,
      file: values.file,
      symbol: values.symbol,
      limit: parseOptionalInt(values.limit, "--limit"),
      depth: parseOptionalInt(values.depth, "--depth"),
    });
    if (values.json) {
      console.log(JSON.stringify(result));
    } else {
      for (const hit of result.hits) {
        console.log(JSON.stringify(hit));
      }
      console.log(`${result.hits.length} result(s)`);
    }
    process.exitCode = 0;
  } else if (activeCommand === "init") {
    const result = runInit({ owner: values.owner, vault: values.vault });
    console.log(`semantic-layer init: scaffolded ${result.vaultDir}`);
    process.exitCode = 0;
  } else if (activeCommand === "refine") {
    await runRefine(subcommandOrQuery, positionalId);
    process.exitCode = 0;
  } else {
    console.error(
      `Unknown command: ${activeCommand}. Use check, index, search, graph, init, refine, or help.`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
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
  --json           Output raw JSON result for agents
  -h, --help       Show help
`;
  }

  if (command === "index" || command === "search-index") {
    return `Usage: semantic-layer ${command} [options]

Regenerate the LadybugDB vault index and compatibility sidecars.

Options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  --full           Force a full rebuild instead of an incremental one
  --json           Output raw JSON result for agents
  -h, --help       Show help
`;
  }

  if (command === "search") {
    return `Usage: semantic-layer search "<query>" [options]

Search the vault's full-text + vector index.

Options:
  --mode <fts|vector|hybrid>  Search mode (default: config defaultMode)
  --limit <n>                 Maximum number of hits (default: config defaultLimit)
  --status <v>                Filter by note status
  --tag <v>                   Filter by tag; may be repeated
  --audience <v>              Filter by audience; may be repeated
  --rebuild                   Refresh the index before searching
  --json                      Output raw JSON result for agents
  --config <path>             Config file path
  --vault <path>              Vault directory override
  --root <path>               Repo root override for code_refs
  -h, --help                  Show help
`;
  }

  if (command === "graph") {
    return `Usage: semantic-layer graph <subcommand> [options]

Explore the vault's graph relationships.

Subcommands:
  backlinks <noteId>    Notes that link to <noteId>
  links <noteId>        Notes that <noteId> links to
  descendants <noteId>  Child notes in the hierarchy
  ancestors <noteId>    Parent notes in the hierarchy
  orphans               Notes (except root) with no wikilinks either direction and no code refs
  related <noteId>      Notes with shared tags or common backlinks
  impact [--file <path>] [--symbol <name>]  Notes declaring code refs matching a file/symbol
  cycles                Detect wikilink cycles

Options:
  --limit <n>     Limit backlinks/links/related/cycles (default: unlimited)
  --depth <n>     Descendant/ancestor traversal depth (default: unlimited)
  --file <path>   File path for impact subcommand
  --symbol <name> Symbol name for impact subcommand
  --json          Output raw JSON result for agents
  --config <path> Config file path
  --vault <path>  Vault directory override
  --root <path>   Repo root override for code_refs
  -h, --help      Show help
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

  return `Usage: semantic-layer <command> [options]

Commands:
  check         Validate a vault (default)
  index         Regenerate the LadybugDB vault index
  search-index  Alias for index
  search        Search the vault index
  graph         Explore vault graph relationships
  init          Scaffold a new vault
  refine        Manage staged evolutionary refinements
  help          Show help

Global options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  --version        Print package version
  -h, --help       Show help
`;
}

async function runRefine(subcommand: string | undefined, id: string | undefined) {
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
    const result = await runRefinementPromote({
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

function parseOptionalInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
