import type { Note, SchemaDoc } from "../types.js";

export type SchemaChildEdge = {
  schemaId: string;
  childId: string;
};

export function extractSchemaEdges(
  schemas: Map<string, SchemaDoc>,
  notes: Map<string, Note>,
): SchemaChildEdge[] {
  const edges: SchemaChildEdge[] = [];

  for (const schemaDoc of schemas.values()) {
    for (const schema of schemaDoc.schemas ?? []) {
      for (const child of schema.children ?? []) {
        const childId = schema.id === "root" ? child : `${schema.id}.${child}`;
        if (notes.has(childId)) {
          edges.push({ schemaId: schema.id, childId });
        }
      }
    }
  }

  return edges;
}
