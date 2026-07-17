import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ResolvedConfig,
  ResolvedSearchConfig,
  SearchConfig,
  SemanticLayerConfig,
} from "./types.js";

const CONFIG_FILES = [
  "semantic-layer.config.yml",
  "semantic-layer.config.yaml",
  "semantic-layer.config.json",
];

export const DEFAULT_CODE_REFS_FILE = ".semantic-layer/code-refs.json";
export const DEFAULT_GEMINI_API_KEY_ENV = "SEMANTIC_LAYER_GEMINI_API_KEY";

const DEFAULT_CONFIG: SemanticLayerConfig = {
  vault: "vault",
  root: ".",
  index: { file: "HIERARCHY.md", codeRefsFile: DEFAULT_CODE_REFS_FILE },
  frontmatter: { requiredExtraFields: [] },
  externalInvariants: [],
  evolution: { stagingDir: "" },
};

export const DEFAULT_SEARCH_CONFIG: ResolvedSearchConfig = {
  enabled: true,
  chunking: { strategy: "heading", maxChunkChars: 2000 },
  embedding: { provider: "fastembed" },
  defaultMode: "hybrid",
  defaultLimit: 10,
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
  const index = {
    file: merged.index.file,
    codeRefsFile: merged.index.codeRefsFile ?? DEFAULT_CODE_REFS_FILE,
  };
  const search = mergeSearchConfig(DEFAULT_SEARCH_CONFIG, merged.search);

  return {
    ...merged,
    index,
    search,
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
    search: override.search ?? base.search,
  };
}

/**
 * Merges a search config override onto its defaults. `embedding` is replaced wholesale (it's a
 * discriminated union — a shallow merge across a provider change could produce an invalid mixed
 * shape); `chunking.strategy` is replaced wholesale too, while `maxChunkChars` falls back to the
 * base value when omitted.
 */
function mergeSearchConfig(
  base: ResolvedSearchConfig,
  override: SearchConfig | undefined,
): ResolvedSearchConfig {
  if (!override) return base;
  const chunking = override.chunking
    ? {
        strategy: override.chunking.strategy,
        maxChunkChars: override.chunking.maxChunkChars ?? base.chunking.maxChunkChars,
      }
    : base.chunking;
  if (chunking.strategy !== "heading" && chunking.strategy !== "whole-note") {
    throw new Error(
      `search.chunking.strategy must be "heading" or "whole-note", got ${JSON.stringify(chunking.strategy)}`,
    );
  }
  if (!Number.isInteger(chunking.maxChunkChars) || chunking.maxChunkChars < 1) {
    throw new Error(
      `search.chunking.maxChunkChars must be a positive integer, got ${chunking.maxChunkChars}`,
    );
  }

  const defaultMode = override.defaultMode ?? base.defaultMode;
  if (defaultMode !== "fts" && defaultMode !== "vector" && defaultMode !== "hybrid") {
    throw new Error(
      `search.defaultMode must be "fts", "vector", or "hybrid", got ${JSON.stringify(defaultMode)}`,
    );
  }

  return {
    enabled: override.enabled ?? base.enabled,
    chunking,
    embedding: override.embedding ?? base.embedding,
    defaultMode,
    defaultLimit: override.defaultLimit ?? base.defaultLimit,
  };
}
