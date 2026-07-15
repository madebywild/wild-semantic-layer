import { insert, search } from "@orama/orama";
import { describe, expect, it } from "vitest";
import {
  createEmptyIndex,
  createSearchSchema,
  SEARCH_SCHEMA_VERSION,
  type SearchDocument,
} from "../../../../../packages/semantic-layer/src/search/schema.js";

function sampleDocument(overrides?: Partial<SearchDocument>): SearchDocument {
  return {
    id: "a",
    noteId: "a",
    chunkIndex: 0,
    headingPath: "",
    title: "Title",
    text: "hello world",
    status: "active",
    tags: [],
    audience: [],
    owner: "me@example.com",
    lastVerified: "2026-01-01",
    modality: "text",
    embedding: [1, 0, 0, 0],
    ...overrides,
  };
}

describe("createSearchSchema", () => {
  it("sizes the embedding field to the given dimensions", () => {
    expect(createSearchSchema(384).embedding).toBe("vector[384]");
    expect(createSearchSchema(3072).embedding).toBe("vector[3072]");
  });

  it("does not declare an id field — Orama manages document identity itself", () => {
    expect(Object.keys(createSearchSchema(384))).not.toContain("id");
  });

  it("declares noteId/status/tags/audience as enum types for cheap where-filtering", () => {
    const schema = createSearchSchema(384);
    expect(schema.noteId).toBe("enum");
    expect(schema.status).toBe("enum");
    expect(schema.tags).toBe("enum[]");
    expect(schema.audience).toBe("enum[]");
    expect(schema.modality).toBe("enum");
  });
});

describe("createEmptyIndex", () => {
  it("creates a usable Orama index accepting vectors of the configured width", async () => {
    const index = createEmptyIndex(4);
    await insert(index, sampleDocument());

    const results = search(index, { term: "hello" });
    expect(results.hits.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("rejects a vector of the wrong width", async () => {
    const index = createEmptyIndex(4);
    // Orama's schema validation throws synchronously, so wrap in a function rather than
    // passing the call's result directly — otherwise the throw escapes before `.rejects` attaches.
    await expect(async () =>
      insert(index, sampleDocument({ embedding: [1, 0] })),
    ).rejects.toThrow();
  });

  it("accepts a document with no embedding at all (FTS-only degradation)", async () => {
    const index = createEmptyIndex(4);
    const { embedding, ...withoutEmbedding } = sampleDocument();
    await insert(index, withoutEmbedding);

    expect(search(index, { term: "hello" }).hits.map((hit) => hit.id)).toEqual(["a"]);
  });
});

it("exposes a stable schema version for manifest compatibility checks", () => {
  expect(SEARCH_SCHEMA_VERSION).toBe(1);
});
