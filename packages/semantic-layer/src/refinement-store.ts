import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { RefinementRecord, RefinementStatus, ResolvedConfig } from "./types.js";

export const REFINEMENT_STATUSES = ["staged", "promoted", "rejected"] as const;

const timestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().min(1),
);

const refinementSchema = z.object({
  schema_version: z.literal(1),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  status: z.enum(REFINEMENT_STATUSES),
  source: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  related_notes: z.array(z.string().min(1)),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  promoted_at: timestampSchema.optional(),
  promoted_notes: z.array(z.string().min(1)).optional(),
  rejected_at: timestampSchema.optional(),
  rejection_reason: z.string().min(1).optional(),
});

type ReadResult =
  | { record: RefinementRecord; errors: [] }
  | { record?: undefined; errors: string[] };

export function ensureRefinementDirs(config: ResolvedConfig): void {
  for (const status of REFINEMENT_STATUSES) {
    mkdirSync(refinementStatusDir(config, status), { recursive: true });
  }
}

export function refinementStatusDir(config: ResolvedConfig, status: RefinementStatus): string {
  return join(config.refinementDir, status);
}

export function refinementFile(
  config: ResolvedConfig,
  status: RefinementStatus,
  id: string,
): string {
  return join(refinementStatusDir(config, status), `${id}.yml`);
}

export function writeRefinementRecord(config: ResolvedConfig, record: RefinementRecord): string {
  ensureRefinementDirs(config);
  const file = refinementFile(config, record.status, record.id);
  writeFileSync(file, stringifyYaml(record));
  return file;
}

export function moveRefinementRecord(
  config: ResolvedConfig,
  from: RefinementStatus,
  record: RefinementRecord,
): string {
  ensureRefinementDirs(config);
  const source = refinementFile(config, from, record.id);
  const target = refinementFile(config, record.status, record.id);
  writeFileSync(source, stringifyYaml(record));
  renameSync(source, target);
  return target;
}

export function readRefinementRecord(file: string): ReadResult {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    return { errors: [`${file} cannot be parsed: ${messageOf(error)}`] };
  }

  const parsed = refinementSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(
        (issue) => `${file} ${issue.path.join(".") || "/"} ${issue.message}`,
      ),
    };
  }

  return { record: parsed.data as RefinementRecord, errors: [] };
}

export function readRefinementRecords(
  config: ResolvedConfig,
  status: RefinementStatus | "all" = "all",
): { records: RefinementRecord[]; errors: string[] } {
  const records: RefinementRecord[] = [];
  const errors: string[] = [];

  for (const folderStatus of statusesFor(status)) {
    const dir = refinementStatusDir(config, folderStatus);
    if (!existsSync(dir)) continue;
    if (!statSync(dir).isDirectory()) {
      errors.push(`${dir} is not a directory`);
      continue;
    }

    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
      const file = join(dir, name);
      const result = readRefinementRecord(file);
      errors.push(...result.errors);
      if (!result.record) continue;

      const expectedId = basename(name).replace(/\.ya?ml$/, "");
      if (result.record.id !== expectedId) {
        errors.push(`${file} id "${result.record.id}" does not match filename "${expectedId}"`);
      }
      if (result.record.status !== folderStatus) {
        errors.push(
          `${file} status "${result.record.status}" does not match folder "${folderStatus}"`,
        );
      }
      records.push(result.record);
    }
  }

  records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return { records, errors };
}

export function validateRefinementStorage(config: ResolvedConfig): string[] {
  const { records, errors } = readRefinementRecords(config);
  for (const record of records) {
    if (record.status === "promoted") {
      if (!record.promoted_at)
        errors.push(`[${record.id}] promoted refinement is missing promoted_at`);
      if (!record.promoted_notes?.length) {
        errors.push(`[${record.id}] promoted refinement is missing promoted_notes`);
      }
    }
    if (record.status === "rejected") {
      if (!record.rejected_at)
        errors.push(`[${record.id}] rejected refinement is missing rejected_at`);
      if (!record.rejection_reason) {
        errors.push(`[${record.id}] rejected refinement is missing rejection_reason`);
      }
    }
  }
  return errors;
}

function statusesFor(status: RefinementStatus | "all"): RefinementStatus[] {
  return status === "all" ? [...REFINEMENT_STATUSES] : [status];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
