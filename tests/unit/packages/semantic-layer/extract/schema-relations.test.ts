import { describe, expect, it } from "vitest";
import { extractSchemaEdges } from "../../../../../packages/semantic-layer/src/extract/schema-relations.js";
import type { Note, SchemaDoc } from "../../../../../packages/semantic-layer/src/types.js";

function makeNote(id: string): Note {
  return {
    id,
    file: `${id}.md`,
    fm: {
      id,
      title: id,
      desc: `${id} description`,
      status: "active",
      owner: "tester@example.com",
      last_verified: "2026-07-16",
      ttl_days: 365,
    },
    body: "",
    headings: new Set(),
    headingSpans: [],
  };
}

function makeSchemaDoc(schemas: SchemaDoc["schemas"]): SchemaDoc {
  return { version: 1, schemas };
}

describe("extractSchemaEdges", () => {
  it("creates edges for schema children", () => {
    const schemas = new Map<string, SchemaDoc>([
      ["root", makeSchemaDoc([{ id: "root", children: ["runtime", "ui"] }])],
    ]);
    const notes = new Map<string, Note>([
      ["runtime", makeNote("runtime")],
      ["ui", makeNote("ui")],
    ]);

    expect(extractSchemaEdges(schemas, notes)).toEqual([
      { schemaId: "root", childId: "runtime" },
      { schemaId: "root", childId: "ui" },
    ]);
  });

  it("prefixes non-root schema ids onto child names", () => {
    const schemas = new Map<string, SchemaDoc>([
      ["demo", makeSchemaDoc([{ id: "demo", children: ["runtime", "ui"] }])],
    ]);
    const notes = new Map<string, Note>([
      ["demo.runtime", makeNote("demo.runtime")],
      ["demo.ui", makeNote("demo.ui")],
    ]);

    expect(extractSchemaEdges(schemas, notes)).toEqual([
      { schemaId: "demo", childId: "demo.runtime" },
      { schemaId: "demo", childId: "demo.ui" },
    ]);
  });

  it("skips children whose note does not exist", () => {
    const schemas = new Map<string, SchemaDoc>([
      ["root", makeSchemaDoc([{ id: "root", children: ["runtime", "missing"] }])],
    ]);
    const notes = new Map<string, Note>([["runtime", makeNote("runtime")]]);

    expect(extractSchemaEdges(schemas, notes)).toEqual([{ schemaId: "root", childId: "runtime" }]);
  });

  it("processes every schema entry in a doc", () => {
    const schemas = new Map<string, SchemaDoc>([
      [
        "root",
        makeSchemaDoc([
          { id: "root", children: ["a"] },
          { id: "demo", children: ["b"] },
        ]),
      ],
    ]);
    const notes = new Map<string, Note>([
      ["a", makeNote("a")],
      ["demo.b", makeNote("demo.b")],
    ]);

    expect(extractSchemaEdges(schemas, notes)).toEqual([
      { schemaId: "root", childId: "a" },
      { schemaId: "demo", childId: "demo.b" },
    ]);
  });
});
