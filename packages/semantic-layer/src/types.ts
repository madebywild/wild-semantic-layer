export type Status = "draft" | "active" | "deprecated";

export type CodeRef = {
  file: string;
  symbol: string;
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

export type Note = {
  id: string;
  file: string;
  fm: NoteFrontmatter;
  body: string;
  headings: Set<string>;
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
};

export type RefinementRejectOptions = {
  id: string;
  reason: string;
};

export type RefinementListResult = {
  refinements: RefinementRecord[];
  errors: string[];
};

export type SemanticLayerConfig = {
  vault: string;
  root: string;
  index: {
    file: string;
  };
  frontmatter: {
    requiredExtraFields: string[];
  };
  externalInvariants: ExternalInvariant[];
  evolution: {
    stagingDir: string;
  };
};

export type ResolvedConfig = SemanticLayerConfig & {
  configFile?: string;
  repoRoot: string;
  vaultDir: string;
  refinementDir: string;
};

export type CheckResult = {
  errors: string[];
  noteCount: number;
};
