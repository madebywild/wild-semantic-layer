import type { Embedder } from "./search/embedder.js";

export type Status = "draft" | "active" | "deprecated";

export type CodeRefKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "var"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "import"
  | "export"
  | "method"
  | "property";

export type CodeRefNamespace = "value" | "type" | "namespace";

export type CodeRef = {
  file: string;
  symbol: string;
  kind?: CodeRefKind;
  namespace?: CodeRefNamespace;
};

export type CodeRefDeclaration = {
  file: string;
  kind: CodeRefKind;
  line: number;
  column: number;
};

export type ResolvedCodeRef = {
  note_id: string;
  ref: CodeRef;
  kind: CodeRefKind;
  namespaces: CodeRefNamespace[];
  line: number;
  column: number;
  declarations: CodeRefDeclaration[];
};

export type CodeRefsIndex = {
  schema_version: 1;
  refs: ResolvedCodeRef[];
};

export type NoteFrontmatter = {
  id: string;
  title: string;
  desc: string;
  status: Status;
  owner: string;
  last_verified: string | Date;
  ttl_days: number;
  audience?: string[];
  code_refs?: CodeRef[];
  tags?: string[];
} & Record<string, unknown>;

/** One Markdown heading line, in document order, with its character offset for chunking. */
export type NoteHeading = {
  text: string;
  slug: string;
  level: number;
  offset: number;
};

export type Note = {
  id: string;
  file: string;
  fm: NoteFrontmatter;
  body: string;
  headings: Set<string>;
  headingSpans: NoteHeading[];
};

export type SchemaDoc = {
  version: number;
  schemas: Array<{
    id: string;
    title?: string;
    desc?: string;
    parent?: string;
    children?: string[];
    pattern?: string;
    namespace?: boolean;
    template?: string;
  }>;
};

export type ExternalInvariant = {
  id: string;
  value: string;
  usedIn: string[];
};

export type RefinementStatus = "staged" | "promoted" | "rejected";

export type RefinementRecord = {
  schema_version: 1;
  id: string;
  status: RefinementStatus;
  source: string;
  title: string;
  summary: string;
  evidence: string[];
  related_notes: string[];
  created_at: string;
  updated_at: string;
  promoted_at?: string;
  promoted_notes?: string[];
  rejected_at?: string;
  rejection_reason?: string;
};

export type RefinementStageOptions = {
  source: string;
  title: string;
  summary: string;
  evidence?: string[];
  relatedNotes?: string[];
};

export type RefinementListOptions = {
  status?: RefinementStatus | "all";
};

export type RefinementPromoteOptions = {
  id: string;
  notes: string[];
  embedder?: Embedder;
};

export type RefinementRejectOptions = {
  id: string;
  reason: string;
};

export type RefinementListResult = {
  refinements: RefinementRecord[];
  errors: string[];
};

export type SearchChunkingStrategy = "whole-note" | "heading";

export type SearchMode = "fts" | "vector" | "hybrid";

/** Which embedder produces vectors for the search index; a discriminated union so provider-specific fields stay valid. */
export type SearchEmbeddingProviderConfig =
  | { provider: "fastembed"; model?: string; cacheDir?: string }
  | { provider: "gemini"; model?: string; apiKeyEnv?: string };

export type SearchConfig = {
  enabled?: boolean;
  chunking?: {
    strategy: SearchChunkingStrategy;
    maxChunkChars?: number;
  };
  embedding?: SearchEmbeddingProviderConfig;
  defaultMode?: SearchMode;
  defaultLimit?: number;
};

/** `SearchConfig` with every optional field defaulted, as carried on `ResolvedConfig`. */
export type ResolvedSearchConfig = {
  enabled: boolean;
  chunking: {
    strategy: SearchChunkingStrategy;
    maxChunkChars: number;
  };
  embedding: SearchEmbeddingProviderConfig;
  defaultMode: SearchMode;
  defaultLimit: number;
};

export type SemanticLayerConfig = {
  vault: string;
  root: string;
  index: {
    file: string;
    codeRefsFile?: string;
  };
  frontmatter: {
    requiredExtraFields: string[];
  };
  externalInvariants: ExternalInvariant[];
  evolution: {
    stagingDir: string;
  };
  search?: SearchConfig;
};

export type ResolvedConfig = Omit<SemanticLayerConfig, "index" | "search"> & {
  index: {
    file: string;
    codeRefsFile?: string;
  };
  search: ResolvedSearchConfig;
  configFile?: string;
  repoRoot: string;
  vaultDir: string;
  refinementDir: string;
};

export type CheckResult = {
  errors: string[];
  noteCount: number;
};

export type BuildIndexResult = {
  mode: "full" | "incremental";
  ftsOnly: boolean;
  notesIndexed: number;
  notesRemoved: number;
  noteCount: number;
  chunkCount: number;
  dbFile: string;
  metaFile: string;
};

export type SearchQueryOptions = {
  query: string;
  mode?: SearchMode;
  limit?: number;
  status?: string;
  tags?: string[];
  audience?: string[];
  /** Runs a full index rebuild before querying, instead of just warning if the index looks stale. */
  rebuild?: boolean;
};

export type SearchQueryHit = {
  id: string;
  noteId: string;
  headingPath: string;
  title: string;
  text: string;
  status: string;
  /** Higher is better: BM25 for fts, cosine similarity (1 - distance) for vector, RRF for hybrid. */
  score: number;
};

export type SearchQueryResult = {
  mode: SearchMode;
  hits: SearchQueryHit[];
  /** True if the index looked out of date and was NOT rebuilt (a non-fatal warning was printed). */
  stale: boolean;
  /** True if a build ran first: a cold start (no index yet) or an explicit `--rebuild`. */
  rebuilt: boolean;
};

export type BacklinkResult = {
  sourceId: string;
  sourceTitle: string;
  anchor?: string;
  status: string;
};
export type ForwardLinkResult = {
  targetId: string;
  targetTitle: string;
  anchor?: string;
  status: string;
};
export type DescendantResult = { id: string; title: string; depth: number; status: string };
export type AncestorResult = { id: string; title: string; depth: number; status: string };
export type OrphanResult = { id: string; title: string; status: string };
export type RelatedNoteResult = {
  id: string;
  title: string;
  sharedTags: string[];
  commonBacklinks: number;
};
export type CodeImpactResult = {
  noteId: string;
  title: string;
  file: string;
  symbol: string;
  kind: string;
};
export type CycleResult = { path: string[] };
