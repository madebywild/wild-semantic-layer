import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "./config.js";
import { readVault, slug, toIsoDate } from "./vault.js";
import type { CheckResult, NoteFrontmatter, ResolvedConfig } from "./types.js";

const noteSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    desc: z.string().min(1),
    status: z.enum(["draft", "active", "deprecated"]),
    owner: z.string().min(1),
    last_verified: z.union([z.string().min(1), z.date()]),
    ttl_days: z.number().int().nonnegative(),
    audience: z.array(z.string()).optional(),
    code_refs: z.array(z.object({ file: z.string(), symbol: z.string() })).optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export function runCheck(options: LoadConfigOptions = {}): CheckResult {
  return checkResolved(loadConfig(options));
}

export function checkResolved(config: ResolvedConfig): CheckResult {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (!existsSync(config.vaultDir)) {
    return {
      errors: [`vault directory not found: ${config.vaultDir}`],
      noteCount: 0,
    };
  }

  const { notes, schemas } = readVault(config.vaultDir);
  const validNotes = new Set<string>();
  if (!notes.has("root")) fail("vault is missing required `root.md`");

  for (const note of notes.values()) {
    const parsed = noteSchema.safeParse(note.fm);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        fail(`[${note.id}] frontmatter.${issue.path.join(".") || "/"} ${issue.message}`);
      }
      continue;
    }

    const fm = parsed.data as NoteFrontmatter;
    fm.last_verified = toIsoDate(fm.last_verified);
    note.fm = fm;
    validNotes.add(note.id);

    if (fm.id !== note.id) {
      fail(`[${note.id}] frontmatter.id "${fm.id}" does not match filename id "${note.id}"`);
    }
    for (const field of config.frontmatter.requiredExtraFields) {
      const value = fm[field];
      if (value === undefined || value === "") {
        fail(`[${note.id}] frontmatter missing configured field: ${field}`);
      }
    }
  }

  checkHierarchy(notes, fail);
  checkSchemas(notes, schemas, fail);
  checkWikilinks(notes, fail);
  checkCodeRefs(notes, validNotes, config.repoRoot, fail);
  checkFreshness(notes, validNotes, fail);
  checkInvariants(notes, config, fail);

  return { errors, noteCount: notes.size };
}

function checkHierarchy(notes: Map<string, { id: string }>, fail: (message: string) => void) {
  for (const id of notes.keys()) {
    if (id === "root") continue;
    const parts = id.split(".");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join(".");
      if (!notes.has(ancestor)) {
        fail(`[${id}] missing ancestor "${ancestor}.md" in the hierarchy`);
      }
    }
  }
}

function checkSchemas(
  notes: Map<string, { id: string }>,
  schemas: ReturnType<typeof readVault>["schemas"],
  fail: (message: string) => void,
) {
  for (const [top, schemaDoc] of schemas) {
    if (!schemaDoc?.schemas?.length) {
      fail(`${top}.schema.yml is empty or malformed`);
      continue;
    }
    const schema = schemaDoc.schemas.find((entry) => entry.id === top);
    if (!schema) {
      fail(`${top}.schema.yml does not declare a schema with id "${top}"`);
      continue;
    }

    const allowed = new Set(schema.children ?? []);
    const open = schema.namespace === true;
    if (!open) {
      for (const id of notes.keys()) {
        const parts = id.split(".");
        const directChild =
          top === "root"
            ? parts.length === 1 && id !== "root"
            : parts.length === 2 && parts[0] === top;
        if (directChild && !allowed.has(parts.at(-1) ?? "")) {
          fail(`[${id}] not in ${top}.schema.yml children`);
        }
      }
    }

    for (const child of allowed) {
      const childId = top === "root" ? child : `${top}.${child}`;
      if (!notes.has(childId)) {
        fail(`${top}.schema.yml lists child "${child}" but note ${childId}.md does not exist`);
      }
    }
  }
}

function checkWikilinks(
  notes: Map<string, { id: string; body: string; headings: Set<string> }>,
  fail: (message: string) => void,
) {
  for (const note of notes.values()) {
    const scannable = note.body
      .replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length))
      .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));

    for (const match of scannable.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const raw = match[1] ?? "";
      let target = raw.includes("|") ? (raw.split("|").at(1) ?? "") : raw;
      let heading: string | undefined;
      if (target.includes("#")) {
        const [id, hash] = target.split("#");
        target = id ?? "";
        heading = slug(hash ?? "");
      }
      target = target.trim();
      const linked = notes.get(target);
      if (!linked) {
        fail(`[${note.id}] wikilink "[[${raw}]]" points at unknown note "${target}"`);
      } else if (heading && !linked.headings.has(heading)) {
        fail(`[${note.id}] wikilink "[[${raw}]]" points at a missing heading in ${target}.md`);
      }
    }
  }
}

function checkCodeRefs(
  notes: Map<string, { id: string; fm: NoteFrontmatter }>,
  validNotes: Set<string>,
  repoRoot: string,
  fail: (message: string) => void,
) {
  const root = resolve(repoRoot);
  for (const note of notes.values()) {
    if (!validNotes.has(note.id)) continue;
    for (const ref of note.fm.code_refs ?? []) {
      const file = resolve(root, ref.file);
      if (file !== root && !file.startsWith(root + sep)) {
        fail(`[${note.id}] code_ref escapes repo root: ${ref.file}`);
        continue;
      }
      if (!existsSync(file)) {
        fail(`[${note.id}] code_ref file does not exist: ${ref.file}`);
        continue;
      }
      const source = readFileSync(file, "utf8");
      const symbol = escapeReg(ref.symbol);
      const declaration = new RegExp(
        `\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|def)\\s+${symbol}\\b`,
      );
      if (!declaration.test(source)) {
        fail(`[${note.id}] code_ref ${ref.file}#${ref.symbol} not found`);
      }
    }
  }
}

function checkFreshness(
  notes: Map<string, { id: string; fm: NoteFrontmatter }>,
  validNotes: Set<string>,
  fail: (message: string) => void,
) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const note of notes.values()) {
    if (!validNotes.has(note.id)) continue;
    if (note.fm.status === "deprecated") continue;
    const lastVerified = toIsoDate(note.fm.last_verified);
    const verifiedAt = new Date(`${lastVerified}T00:00:00Z`);
    if (Number.isNaN(verifiedAt.getTime())) {
      fail(`[${note.id}] invalid last_verified: ${lastVerified}`);
      continue;
    }
    const expiresAt = new Date(verifiedAt);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + note.fm.ttl_days);
    if (expiresAt < today) {
      const days = Math.ceil((today.getTime() - expiresAt.getTime()) / 86_400_000);
      fail(`[${note.id}] freshness expired ${days} day(s) ago`);
    }
  }
}

function checkInvariants(
  notes: Map<string, { id: string; body: string }>,
  config: ResolvedConfig,
  fail: (message: string) => void,
) {
  for (const invariant of config.externalInvariants) {
    for (const noteId of invariant.usedIn) {
      const note = notes.get(noteId);
      if (!note) {
        fail(`externalInvariant.${invariant.id} references missing note "${noteId}"`);
        continue;
      }
      const token = `{{${invariant.id}}}`;
      if (!note.body.includes(token)) {
        fail(`[${noteId}] missing invariant token ${token}`);
      }
      if (!note.body.includes(invariant.value)) {
        fail(`[${noteId}] invariant ${invariant.id} value "${invariant.value}" is not present`);
      }
    }
  }
}

function escapeReg(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
