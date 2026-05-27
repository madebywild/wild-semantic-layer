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
