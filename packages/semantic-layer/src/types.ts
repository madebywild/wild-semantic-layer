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
};

export type ResolvedConfig = SemanticLayerConfig & {
  configFile?: string;
  repoRoot: string;
  vaultDir: string;
};

export type CheckResult = {
  errors: string[];
  noteCount: number;
};
