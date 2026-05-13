import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../../../packages/semantic-layer/src/index.js";
import { createTempVault } from "../../../helpers.js";

function validNoteMd(
  id: string,
  title = id,
  desc = "Test note.",
  status = "active",
  body = "",
): string {
  return `---\nid: ${id}\ntitle: ${title}\ndesc: ${desc}\nstatus: ${status}\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

describe("check pipeline (integration)", () => {
  it("full check passes on a valid vault", () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root", "Root", "Root note.", "active", "See [[meta]]."),
      "vault/meta.md": validNoteMd("meta", "Meta", "Metadata."),
      "vault/meta.agent-conventions.md": validNoteMd(
        "meta.agent-conventions",
        "Agent Conventions",
        "Conventions.",
      ),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [meta]\n",
      "vault/meta.schema.yml":
        "version: 1\nschemas:\n  - id: meta\n    parent: root\n    namespace: true\n    children: [agent-conventions]\n",
    });

    try {
      const result = runCheck({ cwd: tv.dir });
      expect(result.errors).toHaveLength(0);
      expect(result.noteCount).toBe(3);
    } finally {
      tv.cleanup();
    }
  });

  it("full check with requiredExtraFields passing", () => {
    const tv = createTempVault(
      {
        "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\nlayer: test\n---\n\nRoot note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
      { frontmatter: { requiredExtraFields: ["layer"] } },
    );

    try {
      const result = runCheck({ cwd: tv.dir });
      expect(result.errors.filter((e) => !e.includes("schema"))).toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });

  it("full check with missing requiredExtraFields", () => {
    const tv = createTempVault(
      {
        "vault/root.md": validNoteMd("root"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
      { frontmatter: { requiredExtraFields: ["layer"] } },
    );

    try {
      const result = runCheck({ cwd: tv.dir });
      expect(
        result.errors.some((e) => e.includes("frontmatter missing configured field: layer")),
      ).toBe(true);
    } finally {
      tv.cleanup();
    }
  });

  it("full check with external invariants passing", () => {
    const tv = createTempVault(
      {
        "vault/root.md": validNoteMd("root"),
        "vault/note.md": validNoteMd(
          "note",
          "Note",
          "A note.",
          "active",
          "Version {{version}} is 2.0.0.\n",
        ),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [note]\n",
      },
      {
        externalInvariants: [{ id: "version", value: "2.0.0", usedIn: ["note"] }],
      },
    );

    try {
      const result = runCheck({ cwd: tv.dir });
      expect(result.errors.some((e) => e.includes("invariant"))).toBe(false);
    } finally {
      tv.cleanup();
    }
  });

  it("full check with external invariants failing", () => {
    const tv = createTempVault(
      {
        "vault/root.md": validNoteMd("root"),
        "vault/note.md": validNoteMd("note", "Note", "A note.", "active", "Version is 2.0.0.\n"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [note]\n",
      },
      {
        externalInvariants: [{ id: "version", value: "2.0.0", usedIn: ["note"] }],
      },
    );

    try {
      const result = runCheck({ cwd: tv.dir });
      expect(result.errors.some((e) => e.includes("missing invariant token {{version}}"))).toBe(
        true,
      );
    } finally {
      tv.cleanup();
    }
  });

  it("config file path override works end-to-end", () => {
    const tv = createTempVault({
      "vault/root.md": validNoteMd("root"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
    });

    try {
      const result = runCheck({
        cwd: join(tv.dir, "not-the-config-dir"),
        configPath: join(tv.dir, "semantic-layer.config.yml"),
      });
      expect(result.errors).toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });

  it("vault option override wins over config file", () => {
    const tv = createTempVault(
      {
        "vault/root.md": validNoteMd("root"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
      { vault: "wrong-vault" },
    );

    try {
      const result = runCheck({ cwd: tv.dir, vault: "vault" });
      expect(result.errors).toHaveLength(0);
    } finally {
      tv.cleanup();
    }
  });
});
