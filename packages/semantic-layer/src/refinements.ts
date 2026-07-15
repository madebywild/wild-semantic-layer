import { existsSync } from "node:fs";
import { checkResolved } from "./check.js";
import { type LoadConfigOptions, loadConfig } from "./config.js";
import { indexResolved } from "./index-vault.js";
import {
  ensureRefinementDirs,
  moveRefinementRecord,
  readRefinementRecords,
  refinementFile,
  validateRefinementStorage,
  writeRefinementRecord,
} from "./refinement-store.js";
import type {
  RefinementListOptions,
  RefinementListResult,
  RefinementPromoteOptions,
  RefinementRecord,
  RefinementRejectOptions,
  RefinementStageOptions,
  RefinementStatus,
  ResolvedConfig,
} from "./types.js";
import { slug } from "./vault.js";

export function runRefinementStage(options: LoadConfigOptions & RefinementStageOptions): {
  file: string;
  refinement: RefinementRecord;
} {
  const config = loadConfig(options);
  return stageRefinement(config, options);
}

export function runRefinementList(
  options: LoadConfigOptions & RefinementListOptions = {},
): RefinementListResult {
  const config = loadConfig(options);
  const { records, errors } = readRefinementRecords(config, options.status ?? "all");
  return { refinements: records, errors };
}

export function runRefinementPromote(options: LoadConfigOptions & RefinementPromoteOptions): {
  file: string;
  indexFile: string;
  refinement: RefinementRecord;
} {
  const config = loadConfig(options);
  const notes = normalizeList(options.notes);
  if (notes.length === 0) throw new Error("refine promote requires at least one --note value");

  const record = findStagedRefinement(config, options.id);
  const check = checkResolved(config);
  if (check.errors.length > 0) {
    throw new Error(
      `semantic-layer check failed:\n${check.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  const now = new Date().toISOString();
  const promoted: RefinementRecord = {
    ...record,
    status: "promoted",
    updated_at: now,
    promoted_at: now,
    promoted_notes: notes,
  };
  const file = moveRefinementRecord(config, "staged", promoted);
  const metadataErrors = validateRefinementStorage(config);
  if (metadataErrors.length > 0) {
    throw new Error(`refinement metadata validation failed:\n${metadataErrors.join("\n")}`);
  }
  const indexed = indexResolved(config);
  return { file, indexFile: indexed.outFile, refinement: promoted };
}

export function runRefinementReject(options: LoadConfigOptions & RefinementRejectOptions): {
  file: string;
  refinement: RefinementRecord;
} {
  const config = loadConfig(options);
  const reason = options.reason.trim();
  if (!reason) throw new Error("refine reject requires a non-empty --reason value");

  const record = findStagedRefinement(config, options.id);
  const now = new Date().toISOString();
  const rejected: RefinementRecord = {
    ...record,
    status: "rejected",
    updated_at: now,
    rejected_at: now,
    rejection_reason: reason,
  };
  const file = moveRefinementRecord(config, "staged", rejected);
  const metadataErrors = validateRefinementStorage(config);
  if (metadataErrors.length > 0) {
    throw new Error(`refinement metadata validation failed:\n${metadataErrors.join("\n")}`);
  }
  return { file, refinement: rejected };
}

export function stageRefinement(
  config: ResolvedConfig,
  options: RefinementStageOptions,
): { file: string; refinement: RefinementRecord } {
  const source = options.source.trim();
  const title = options.title.trim();
  const summary = options.summary.trim();
  if (!source) throw new Error("refine stage requires a non-empty source");
  if (!title) throw new Error("refine stage requires a non-empty title");
  if (!summary) throw new Error("refine stage requires a non-empty summary");

  ensureRefinementDirs(config);
  const now = new Date().toISOString();
  const refinement: RefinementRecord = {
    schema_version: 1,
    id: nextRefinementId(config, title, now),
    status: "staged",
    source,
    title,
    summary,
    evidence: normalizeList(options.evidence ?? []),
    related_notes: normalizeList(options.relatedNotes ?? []),
    created_at: now,
    updated_at: now,
  };
  const file = writeRefinementRecord(config, refinement);
  return { file, refinement };
}

function findStagedRefinement(config: ResolvedConfig, id: string): RefinementRecord {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("refinement id is required");

  const { records, errors } = readRefinementRecords(config, "staged");
  if (errors.length > 0) {
    throw new Error(`refinement metadata validation failed:\n${errors.join("\n")}`);
  }
  const record = records.find((candidate) => candidate.id === normalizedId);
  if (!record) throw new Error(`staged refinement not found: ${normalizedId}`);
  return record;
}

function nextRefinementId(config: ResolvedConfig, title: string, timestamp: string): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
  const titleSlug = slug(title).slice(0, 48) || "refinement";
  const base = `${stamp}-${titleSlug}`;
  let candidate = base;
  let counter = 2;
  while (refinementExists(config, candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function refinementExists(config: ResolvedConfig, id: string): boolean {
  return (["staged", "promoted", "rejected"] as RefinementStatus[]).some((status) =>
    existsSync(refinementFile(config, status, id)),
  );
}

function normalizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}
