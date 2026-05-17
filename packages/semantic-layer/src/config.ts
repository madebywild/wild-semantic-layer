import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedConfig, SemanticLayerConfig } from "./types.js";

const CONFIG_FILES = [
  "semantic-layer.config.yml",
  "semantic-layer.config.yaml",
  "semantic-layer.config.json",
];

const DEFAULT_CONFIG: SemanticLayerConfig = {
  vault: "vault",
  root: ".",
  index: { file: "HIERARCHY.md" },
  frontmatter: { requiredExtraFields: [] },
  externalInvariants: [],
  evolution: { stagingDir: "" },
};

export type LoadConfigOptions = {
  cwd?: string;
  configPath?: string;
  vault?: string;
  root?: string;
};

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configFile = options.configPath
    ? resolve(cwd, options.configPath)
    : CONFIG_FILES.map((name) => resolve(cwd, name)).find(existsSync);
  const baseDir = configFile ? dirname(configFile) : cwd;
  const fileConfig = configFile ? readConfigFile(configFile) : {};
  const merged = mergeConfig(DEFAULT_CONFIG, fileConfig);

  if (options.vault) merged.vault = options.vault;
  if (options.root) merged.root = options.root;
  if (!merged.evolution.stagingDir) {
    merged.evolution.stagingDir = `${merged.vault}/.semantic-layer/refinements`;
  }

  return {
    ...merged,
    configFile,
    repoRoot: resolve(baseDir, merged.root),
    vaultDir: resolve(baseDir, merged.vault),
    refinementDir: resolve(baseDir, merged.evolution.stagingDir),
  };
}

function readConfigFile(file: string): Partial<SemanticLayerConfig> {
  const raw = readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
}

function mergeConfig(
  base: SemanticLayerConfig,
  override: Partial<SemanticLayerConfig>,
): SemanticLayerConfig {
  return {
    vault: override.vault ?? base.vault,
    root: override.root ?? base.root,
    index: { ...base.index, ...override.index },
    frontmatter: { ...base.frontmatter, ...override.frontmatter },
    externalInvariants: override.externalInvariants ?? base.externalInvariants,
    evolution: { ...base.evolution, ...override.evolution },
  };
}
