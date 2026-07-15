import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { Note, NoteFrontmatter, NoteHeading, SchemaDoc } from "./types.js";

export type Vault = {
  notes: Map<string, Note>;
  schemas: Map<string, SchemaDoc>;
};

export function readVault(vaultDir: string): Vault {
  const notes = new Map<string, Note>();
  const schemas = new Map<string, SchemaDoc>();

  if (!existsSync(vaultDir)) return { notes, schemas };

  for (const name of readdirSync(vaultDir)) {
    const file = join(vaultDir, name);
    if (name === "HIERARCHY.md") continue;
    if (name.endsWith(".schema.yml") || name.endsWith(".schema.yaml")) {
      const top = name.replace(/\.schema\.ya?ml$/, "");
      schemas.set(top, parseYaml(readFileSync(file, "utf8")) as SchemaDoc);
      continue;
    }
    if (!name.endsWith(".md")) continue;

    const id = name.slice(0, -3);
    const parsed = matter(readFileSync(file, "utf8"));
    const headings = new Set<string>();
    const headingSpans: NoteHeading[] = [];
    for (const match of parsed.content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
      const text = match[2] ?? "";
      const headingSlug = slug(text);
      headings.add(headingSlug);
      headingSpans.push({
        text,
        slug: headingSlug,
        level: (match[1] ?? "").length,
        offset: match.index ?? 0,
      });
    }
    notes.set(id, {
      id,
      file,
      fm: parsed.data as NoteFrontmatter,
      body: parsed.content,
      headings,
      headingSpans,
    });
  }

  return { notes, schemas };
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function toIsoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
