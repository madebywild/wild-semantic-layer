import { type LoadConfigOptions, loadConfig } from "../config.js";
import type { Embedder } from "../search/embedder.js";
import type { SearchQueryOptions, SearchQueryResult } from "../types.js";

/**
 * Loads config from disk/CLI options, then runs a search query. The db layer (and LadybugDB's
 * native module with it) is imported lazily so library consumers pulling in unrelated helpers
 * never load native code.
 */
export async function runSearch(
  options: LoadConfigOptions & SearchQueryOptions & { embedder?: Embedder },
): Promise<SearchQueryResult> {
  const { embedder, cwd, configPath, vault, root, ...queryOptions } = options;
  const config = loadConfig({ cwd, configPath, vault, root });
  const { querySearch } = await import("../db/queries/search.js");
  return querySearch(config, queryOptions, { embedder });
}
