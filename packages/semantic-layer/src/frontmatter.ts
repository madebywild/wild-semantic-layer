import { z } from "zod";
import { codeRefArraySchema } from "./code-refs.js";
import type { NoteFrontmatter } from "./types.js";

export const noteFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    desc: z.string().min(1),
    status: z.enum(["draft", "active", "deprecated"]),
    owner: z.string().min(1),
    last_verified: z.union([z.string().min(1), z.date()]),
    ttl_days: z.number().int().nonnegative(),
    audience: z.array(z.string()).optional(),
    code_refs: codeRefArraySchema.optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type FrontmatterValidationResult =
  | { ok: true; frontmatter: NoteFrontmatter; errors?: never }
  | { ok: false; errors: string[]; frontmatter?: never };

export function validateNoteFrontmatter(note: {
  id: string;
  fm: NoteFrontmatter;
}): FrontmatterValidationResult {
  const parsed = noteFrontmatterSchema.safeParse(note.fm);
  if (parsed.success) return { ok: true, frontmatter: parsed.data as NoteFrontmatter };

  return {
    ok: false,
    errors: parsed.error.issues.map(
      (issue) => `[${note.id}] frontmatter.${issue.path.join(".") || "/"} ${issue.message}`,
    ),
  };
}

/**
 * Splits vault notes into valid ones (with normalized frontmatter written back onto the note) and
 * validation error messages. Shared by the index build and the sidecar writers so an invalid note
 * can never be treated differently by the two paths.
 */
export function validateVaultNotes<T extends { id: string; fm: NoteFrontmatter }>(
  notes: Map<string, T>,
): { validNotes: Map<string, T>; errors: string[] } {
  const validNotes = new Map<string, T>();
  const errors: string[] = [];
  for (const note of notes.values()) {
    const parsed = validateNoteFrontmatter(note);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    note.fm = parsed.frontmatter;
    validNotes.set(note.id, note);
  }
  return { validNotes, errors };
}

/** Formats a list of validation errors as the standard `semantic-layer index` failure message. */
export function formatIndexErrors(errors: string[]): string {
  return `semantic-layer index failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`;
}
