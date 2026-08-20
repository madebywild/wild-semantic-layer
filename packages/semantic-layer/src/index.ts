export { runCheck } from "./check.js";
export type { GraphCommandResult } from "./commands/graph.js";
export { runGraph } from "./commands/graph.js";
export { indexResolved, runIndex } from "./commands/index.js";
export { runSearch } from "./commands/search.js";
export { loadConfig } from "./config.js";
export { runInit } from "./init.js";
export {
  runRefinementList,
  runRefinementPromote,
  runRefinementReject,
  runRefinementStage,
} from "./refinements.js";
export type { Embedder } from "./search/embedder.js";
export { LocalEmbedderUnavailableError } from "./search/embedder.js";
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
  ResolvedWikilinkConfig,
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
  WikilinkAliasOrder,
  WikilinkConfig,
} from "./types.js";
