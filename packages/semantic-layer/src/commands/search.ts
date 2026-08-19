import { type LoadConfigOptions, loadConfig } from "../config.js";
import type { Embedder } from "../search/embedder.js";
import type { SearchQueryOptions, SearchQueryResult } from "../types.js";

/**
 * Loads config from disk/CLI options, then lazily imports the SQLite query layer so consumers of
 * unrelated validation helpers do not open the vault index.
 */
export async function runSearch(
  options: LoadConfigOptions & SearchQueryOptions & { embedder?: Embedder },
): Promise<SearchQueryResult> {
  const { embedder, cwd, configPath, vault, root, ...queryOptions } = options;
  const config = loadConfig({ cwd, configPath, vault, root });
  const { querySearch } = await import("../db/queries/search.js");
  return querySearch(config, queryOptions, { embedder });
}
