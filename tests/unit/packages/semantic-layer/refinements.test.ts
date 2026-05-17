import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../../../packages/semantic-layer/src/check.js";
import {
  runRefinementList,
  runRefinementPromote,
  runRefinementReject,
  runRefinementStage,
} from "../../../../packages/semantic-layer/src/refinements.js";
import { readVault } from "../../../../packages/semantic-layer/src/vault.js";
import { createTempVault } from "../../../helpers.js";

function validNoteMd(id: string, title = id, desc = "Test note."): string {
  return `---\nid: ${id}\ntitle: ${title}\ndesc: ${desc}\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n# ${title}\n`;
}

function validVault() {
  return createTempVault({
    "vault/root.md": validNoteMd("root"),
    "vault/root.schema.yml":
      "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("refinement lifecycle", () => {
  it("stages and lists a distilled refinement record", () => {
    const tv = validVault();
    try {
      const staged = runRefinementStage({
        cwd: tv.dir,
        source: "user-message",
        title: "Runtime decision",
        summary: "The project runtime contract should mention Node.js 24.",
        evidence: ["User said the runtime is Node.js 24."],
        relatedNotes: ["root"],
      });

      expect(staged.refinement.status).toBe("staged");
      expect(staged.refinement.related_notes).toEqual(["root"]);
      expect(existsSync(staged.file)).toBe(true);

      const list = runRefinementList({ cwd: tv.dir, status: "staged" });
      expect(list.errors).toEqual([]);
      expect(list.refinements.map((item) => item.id)).toEqual([staged.refinement.id]);
    } finally {
      tv.cleanup();
    }
  });

  it("creates a unique id when staging records share a timestamp and title", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T10:00:00Z"));
    const tv = validVault();
    try {
      const first = runRefinementStage({
        cwd: tv.dir,
        source: "task",
        title: "Same title",
        summary: "First durable signal.",
      });
      const second = runRefinementStage({
        cwd: tv.dir,
        source: "task",
        title: "Same title",
        summary: "Second durable signal.",
      });

      expect(second.refinement.id).toBe(`${first.refinement.id}-2`);
    } finally {
      tv.cleanup();
    }
  });

  it("rejects empty staged refinement fields", () => {
    const tv = validVault();
    try {
      expect(() =>
        runRefinementStage({
          cwd: tv.dir,
          source: "",
          title: "Title",
          summary: "Summary",
        }),
      ).toThrow("source");
      expect(() =>
        runRefinementStage({
          cwd: tv.dir,
          source: "task",
          title: "",
          summary: "Summary",
        }),
      ).toThrow("title");
      expect(() =>
        runRefinementStage({
          cwd: tv.dir,
          source: "task",
          title: "Title",
          summary: "",
        }),
      ).toThrow("summary");
    } finally {
      tv.cleanup();
    }
  });

  it("keeps staged refinements outside trusted vault reads and note counts", () => {
    const tv = validVault();
    try {
      runRefinementStage({
        cwd: tv.dir,
        source: "task",
        title: "Root convention",
        summary: "Root conventions may need a future update.",
      });

      const { notes } = readVault(tv.vaultDir);
      expect(notes.size).toBe(1);

      const check = runCheck({ cwd: tv.dir });
      expect(check.errors).toEqual([]);
      expect(check.noteCount).toBe(1);
    } finally {
      tv.cleanup();
    }
  });

  it("reports malformed refinement metadata during check", () => {
    const tv = validVault();
    try {
      const stagedDir = join(tv.vaultDir, ".semantic-layer", "refinements", "staged");
      mkdirSync(stagedDir, { recursive: true });
      writeFileSync(join(stagedDir, "bad.yml"), "id: bad\nstatus: staged\n");

      const check = runCheck({ cwd: tv.dir });
      expect(check.errors.some((error) => error.includes("refinement"))).toBe(true);
      expect(check.errors.some((error) => error.includes("schema_version"))).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("reports parse errors and status directory shape problems", () => {
    const tv = validVault();
    try {
      const refinementDir = join(tv.vaultDir, ".semantic-layer", "refinements");
      mkdirSync(refinementDir, { recursive: true });
      writeFileSync(join(refinementDir, "staged"), "not a directory");
      const list = runRefinementList({ cwd: tv.dir, status: "staged" });
      expect(list.errors.some((error) => error.includes("is not a directory"))).toBe(true);

      const rejectedDir = join(refinementDir, "rejected");
      mkdirSync(rejectedDir, { recursive: true });
      writeFileSync(join(rejectedDir, "bad.yml"), "title: [");
      const rejected = runRefinementList({ cwd: tv.dir, status: "rejected" });
      expect(rejected.errors.some((error) => error.includes("cannot be parsed"))).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("reports filename, folder, and lifecycle metadata mismatches", () => {
    const tv = validVault();
    try {
      const stagedDir = join(tv.vaultDir, ".semantic-layer", "refinements", "staged");
      const promotedDir = join(tv.vaultDir, ".semantic-layer", "refinements", "promoted");
      const rejectedDir = join(tv.vaultDir, ".semantic-layer", "refinements", "rejected");
      mkdirSync(stagedDir, { recursive: true });
      mkdirSync(promotedDir, { recursive: true });
      mkdirSync(rejectedDir, { recursive: true });
      writeRecord(join(stagedDir, "wrong.yml"), {
        id: "actual",
        status: "promoted",
      });
      writeRecord(join(promotedDir, "promoted-missing.yml"), {
        id: "promoted-missing",
        status: "promoted",
      });
      writeRecord(join(rejectedDir, "rejected-missing.yml"), {
        id: "rejected-missing",
        status: "rejected",
      });

      const check = runCheck({ cwd: tv.dir });
      expect(check.errors.some((error) => error.includes("does not match filename"))).toBe(true);
      expect(check.errors.some((error) => error.includes("does not match folder"))).toBe(true);
      expect(check.errors.some((error) => error.includes("promoted_at"))).toBe(true);
      expect(check.errors.some((error) => error.includes("rejection_reason"))).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("promotes a staged refinement only after check passes and regenerates the index", () => {
    const tv = validVault();
    try {
      const staged = runRefinementStage({
        cwd: tv.dir,
        source: "user-message",
        title: "Root should stay current",
        summary: "Root documentation was reviewed and remains current.",
        relatedNotes: ["root"],
      });

      const promoted = runRefinementPromote({
        cwd: tv.dir,
        id: staged.refinement.id,
        notes: ["root"],
      });

      expect(promoted.refinement.status).toBe("promoted");
      expect(promoted.refinement.promoted_notes).toEqual(["root"]);
      expect(readFileSync(promoted.indexFile, "utf8")).toContain("**root**");

      const list = runRefinementList({ cwd: tv.dir, status: "promoted" });
      expect(list.refinements.map((item) => item.id)).toEqual([staged.refinement.id]);
      expect(runRefinementList({ cwd: tv.dir, status: "staged" }).refinements).toEqual([]);
    } finally {
      tv.cleanup();
    }
  });

  it("refuses promotion without notes, missing records, blank ids, or a passing check", () => {
    const tv = validVault();
    try {
      const staged = runRefinementStage({
        cwd: tv.dir,
        source: "user-message",
        title: "Promotion guard",
        summary: "Promotion should be guarded by check.",
      });

      expect(() =>
        runRefinementPromote({ cwd: tv.dir, id: staged.refinement.id, notes: [] }),
      ).toThrow("--note");
      expect(() => runRefinementPromote({ cwd: tv.dir, id: " ", notes: ["root"] })).toThrow(
        "refinement id",
      );
      expect(() =>
        runRefinementPromote({ cwd: tv.dir, id: "missing-refinement", notes: ["root"] }),
      ).toThrow("not found");

      const rootPath = join(tv.vaultDir, "root.md");
      writeFileSync(rootPath, readFileSync(rootPath, "utf8").replace("title: root", 'title: ""'));
      expect(() =>
        runRefinementPromote({ cwd: tv.dir, id: staged.refinement.id, notes: ["root"] }),
      ).toThrow("semantic-layer check failed");
    } finally {
      tv.cleanup();
    }
  });

  it("rejects a staged refinement with an audit reason", () => {
    const tv = validVault();
    try {
      const staged = runRefinementStage({
        cwd: tv.dir,
        source: "activity",
        title: "Ephemeral task note",
        summary: "This looked temporary after review.",
      });

      const rejected = runRefinementReject({
        cwd: tv.dir,
        id: staged.refinement.id,
        reason: "Ephemeral task detail, not durable project knowledge.",
      });

      expect(rejected.refinement.status).toBe("rejected");
      expect(rejected.refinement.rejection_reason).toContain("Ephemeral");
      const list = runRefinementList({ cwd: tv.dir, status: "rejected" });
      expect(list.refinements).toHaveLength(1);
    } finally {
      tv.cleanup();
    }
  });

  it("refuses rejection without a reason", () => {
    const tv = validVault();
    try {
      const staged = runRefinementStage({
        cwd: tv.dir,
        source: "activity",
        title: "Needs rejection",
        summary: "This should not be durable.",
      });

      expect(() =>
        runRefinementReject({ cwd: tv.dir, id: staged.refinement.id, reason: " " }),
      ).toThrow("--reason");
    } finally {
      tv.cleanup();
    }
  });
});

function writeRecord(
  file: string,
  overrides: {
    id: string;
    status: "staged" | "promoted" | "rejected";
  },
) {
  writeFileSync(
    file,
    [
      "schema_version: 1",
      `id: ${overrides.id}`,
      `status: ${overrides.status}`,
      "source: test",
      "title: Test refinement",
      "summary: Test summary.",
      "evidence: []",
      "related_notes: []",
      "created_at: '2026-05-16T10:00:00.000Z'",
      "updated_at: '2026-05-16T10:00:00.000Z'",
      "",
    ].join("\n"),
  );
}
