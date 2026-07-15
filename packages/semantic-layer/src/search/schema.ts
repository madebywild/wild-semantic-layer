import { create, type Orama, type Vector } from "@orama/orama";

/** Bumped whenever the Orama schema shape changes in a way that requires a full rebuild. */
export const SEARCH_SCHEMA_VERSION = 1;

/** Reserved for a future image embedder; only "text" chunks are produced today. */
export type SearchModality = "text" | "image";

function embeddingField(dimensions: number): Vector {
  return `vector[${dimensions}]` as Vector;
}

/**
 * Builds the Orama schema sized to the active embedder's vector width. `id` is deliberately not a
 * schema field: Orama treats every document's top-level `id` as its stable identity (see
 * `SearchDocument`), not a searchable property, so declaring it here would index it as text.
 */
export function createSearchSchema(dimensions: number) {
  return {
    noteId: "enum",
    chunkIndex: "number",
    headingPath: "string",
    title: "string",
    text: "string",
    status: "enum",
    tags: "enum[]",
    audience: "enum[]",
    owner: "string",
    lastVerified: "string",
    modality: "enum",
    embedding: embeddingField(dimensions),
  } as const;
}

export type SearchSchema = ReturnType<typeof createSearchSchema>;

export type SearchIndex = Orama<SearchSchema>;

/** Document shape accepted by `insert`/`insertMultiple` against a `SearchIndex`. */
export type SearchDocument = {
  id: string;
  noteId: string;
  chunkIndex: number;
  headingPath: string;
  title: string;
  text: string;
  status: string;
  tags: string[];
  audience: string[];
  owner: string;
  lastVerified: string;
  modality: SearchModality;
  embedding?: number[];
};

/** Creates a fresh, empty search index for the given embedder vector width. */
export function createEmptyIndex(dimensions: number): SearchIndex {
  return create({ schema: createSearchSchema(dimensions) });
}
