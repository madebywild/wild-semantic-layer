#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCheck } from "./check.js";
import { runIndex } from "./index-vault.js";
import { runInit } from "./init.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
    owner: { type: "string" },
    root: { type: "string" },
    vault: { type: "string" },
    version: { type: "boolean" },
  },
});

const [command, helpCommand] = positionals;
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
    console.log(`semantic-layer index: wrote ${result.outFile} (${result.noteCount} notes)`);
    process.exit(0);
  }

  if (activeCommand === "init") {
    const result = runInit({ owner: values.owner, vault: values.vault });
    console.log(`semantic-layer init: scaffolded ${result.vaultDir}`);
    process.exit(0);
  }

  console.error(`Unknown command: ${activeCommand}. Use check, index, init, or help.`);
  process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function getVersion() {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
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

Regenerate the agent-facing hierarchy index.

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

  return `Usage: semantic-layer <command> [options]

Commands:
  check    Validate a vault (default)
  index    Regenerate vault/HIERARCHY.md
  init     Scaffold a new vault
  help     Show help

Global options:
  --config <path>  Config file path
  --vault <path>   Vault directory override
  --root <path>    Repo root override for code_refs
  --version        Print package version
  -h, --help       Show help
`;
}
