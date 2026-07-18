export { runCheck } from "./check.js";
export { loadConfig } from "./config.js";
// Native-free: pool.ts only type-imports @ladybugdb/core, so this export stays musl-safe.
export { closePooledDatabases } from "./db/pool.js";
export { runGraph } from "./commands/graph.js";
export { indexResolved, runIndex } from "./commands/index.js";
export { runSearch } from "./commands/search.js";
export { runInit } from "./init.js";
export {
  runRefinementList,
  runRefinementPromote,
  runRefinementReject,
  runRefinementStage,
} from "./refinements.js";
export type { Embedder } from "./search/embedder.js";
export { LocalEmbedderUnavailableError } from "./search/embedder.js";
export type { GraphCommandResult } from "./commands/graph.js";
export type {
  AncestorResult,
  BacklinkResult,
  BuildIndexResult,
  CheckResult,
  CodeImpactResult,
  CodeRef,
  CodeRefDeclaration,
  CodeRefKind,
  CodeRefNamespace,
  CodeRefsIndex,
  CycleResult,
  DescendantResult,
  ExternalInvariant,
  ForwardLinkResult,
  Note,
  NoteFrontmatter,
  NoteHeading,
  OrphanResult,
  RefinementListOptions,
  RefinementListResult,
  RefinementPromoteOptions,
  RefinementRecord,
  RefinementRejectOptions,
  RefinementStageOptions,
  RefinementStatus,
  RelatedNoteResult,
  ResolvedCodeRef,
  ResolvedConfig,
  ResolvedSearchConfig,
  SchemaDoc,
  SearchChunkingStrategy,
  SearchConfig,
  SearchEmbeddingProviderConfig,
  SearchMode,
  SearchQueryHit,
  SearchQueryOptions,
  SearchQueryResult,
  SemanticLayerConfig,
  Status,
} from "./types.js";
