import { type LoadConfigOptions, loadConfig } from "../config.js";
import { querySearch } from "../db/queries/search.js";
import type { Embedder } from "../search/embedder.js";
import type { SearchQueryOptions, SearchQueryResult } from "../types.js";

/** Loads config from disk/CLI options, then runs a search query. */
export async function runSearch(
  options: LoadConfigOptions & SearchQueryOptions & { embedder?: Embedder },
): Promise<SearchQueryResult> {
  const { embedder, cwd, configPath, vault, root, ...queryOptions } = options;
  const config = loadConfig({ cwd, configPath, vault, root });
  return querySearch(config, queryOptions, { embedder });
}
