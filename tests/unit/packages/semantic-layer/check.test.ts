import { describe, expect, it } from "vitest";
import { checkResolved } from "../../../../packages/semantic-layer/src/check.js";
import type { ResolvedConfig } from "../../../../packages/semantic-layer/src/types.js";
import { createResolvedConfig, createTempVault } from "../../../helpers.js";

/**
 * Creates a minimal valid vault in a temp directory and returns
 * the ResolvedConfig + cleanup function.
 */
function setupValidVault(extra?: {
  files?: Record<string, string>;
  config?: Partial<ResolvableConfig>;
}): { config: ResolvedConfig; cleanup: () => void } {
  const defaultFiles: Record<string, string> = {
    "vault/root.md": validNote("root", "Root", "Root note.", "active"),
    "vault/root.schema.yml":
      "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
  };
  const files = { ...defaultFiles, ...extra?.files };
  const tv = createTempVault(files, extra?.config);
  return {
    config: {
      vault: "vault",
      root: ".",
      index: { file: "HIERARCHY.md" },
      frontmatter: { requiredExtraFields: [] },
      externalInvariants: [],
      repoRoot: tv.repoRoot,
      vaultDir: tv.vaultDir,
      configFile: undefined,
    },
    cleanup: tv.cleanup,
  };
}

type ResolvableConfig = {
  vault?: string;
  root?: string;
  index?: { file: string };
  frontmatter?: { requiredExtraFields: string[] };
  externalInvariants?: Array<{ id: string; value: string; usedIn: string[] }>;
};

function validNote(
  id: string,
  title = id,
  desc = "Test note.",
  status: "draft" | "active" | "deprecated" = "active",
  extras: Record<string, unknown> = {},
  body = "",
): string {
  const fm: Record<string, unknown> = {
    id,
    title,
    desc,
    status,
    owner: "tester@example.com",
    last_verified: "2026-05-13",
    ttl_days: 365,
    ...extras,
  };
  const frontmatter = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
          const items = v.map((item) => {
            const props = Object.entries(item as Record<string, unknown>)
              .map(([pk, pv]) => `${pk}: ${yamlVal(pv)}`)
              .join(", ");
            return `{ ${props} }`;
          });
          return `${k}:\n${items.map((i) => `  - ${i}`).join("\n")}`;
        }
        return `${k}: [${v.join(", ")}]`;
      }
      return `${k}: ${yamlVal(v)}`;
    })
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function yamlVal(v: unknown): string {
  if (typeof v === "string") {
    // Quote strings that are empty, contain special YAML chars, or look like booleans/numbers
    if (
      v === "" ||
      /[:#[\]{}|>!'"%@,&*?\\]/.test(v) ||
      v === "true" ||
      v === "false" ||
      v === "null" ||
      /^\d+$/.test(v)
    ) {
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    return v;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "null";
  return String(v);
}

// ============================================================
// Frontmatter validation
// ============================================================

describe("checkResolved — frontmatter", () => {
  it("accepts valid frontmatter", () => {
    const { config, cleanup } = setupValidVault();
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects empty id", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/bad.md": `---\nid: ""\ntitle: Bad\ndesc: Bad note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\nBad note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.id"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects empty title", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": `---\nid: root\ntitle: ""\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\nRoot note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.title"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects empty desc", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": `---\nid: root\ntitle: Root\ndesc: ""\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\nRoot note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.desc"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid status value", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "unknown-status" as "active"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.status"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects negative ttl_days", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", { ttl_days: -1 }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.ttl_days"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects empty owner", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: ""\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\nRoot note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("frontmatter.owner"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts optional audience array", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {
          audience: ["agents", "eng"],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("accepts optional tags array", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", { tags: ["meta"] }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// ID/filename mismatch
// ============================================================

describe("checkResolved — id/filename mismatch", () => {
  it("accepts matching id and filename", () => {
    const { config, cleanup } = setupValidVault();
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects id that differs from filename", () => {
    const noteContent = `---\nid: wrong-name\ntitle: Test\ndesc: Test.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\nTest.`;
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/mismatch.md": noteContent,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("does not match filename id"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Required extra fields
// ============================================================

describe("checkResolved — required extra fields", () => {
  it("rejects missing configured extra field", () => {
    const { config, cleanup } = setupValidVault();
    config.frontmatter.requiredExtraFields = ["layer"];
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some((e) => e.includes("frontmatter missing configured field: layer")),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts present configured extra field", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", { layer: "test" }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    config.frontmatter.requiredExtraFields = ["layer"];
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects empty string for configured extra field", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", { layer: "" }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    config.frontmatter.requiredExtraFields = ["layer"];
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some((e) => e.includes("frontmatter missing configured field: layer")),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Missing root.md
// ============================================================

describe("checkResolved — missing root", () => {
  it("reports missing root.md", () => {
    const tv = createTempVault({
      "vault/alpha.md": validNote("alpha"),
    });
    const config: ResolvedConfig = {
      vault: "vault",
      root: ".",
      index: { file: "HIERARCHY.md" },
      frontmatter: { requiredExtraFields: [] },
      externalInvariants: [],
      repoRoot: tv.repoRoot,
      vaultDir: tv.vaultDir,
      configFile: undefined,
    };
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("missing required `root.md`"))).toBe(true);
    } finally {
      tv.cleanup();
    }
  });
});

// ============================================================
// Hierarchy
// ============================================================

describe("checkResolved — hierarchy", () => {
  it("accepts root note without ancestor requirement", () => {
    const { config, cleanup } = setupValidVault();
    try {
      const result = checkResolved(config);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("accepts single-dot note with root as only ancestor", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/alpha.md": validNote("alpha"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
      },
    });
    try {
      const hierarchyErrors = checkResolved(config).errors.filter((e) =>
        e.includes("missing ancestor"),
      );
      expect(hierarchyErrors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("accepts nested notes when all ancestors exist", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/auth.md": validNote("auth"),
        "vault/auth.flow.md": validNote("auth.flow"),
        "vault/auth.flow.detail.md": validNote("auth.flow.detail"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [auth]\n",
        "vault/auth.schema.yml":
          "version: 1\nschemas:\n  - id: auth\n    parent: root\n    namespace: true\n    children: []\n",
      },
    });
    try {
      const hierarchyErrors = checkResolved(config).errors.filter((e) =>
        e.includes("missing ancestor"),
      );
      expect(hierarchyErrors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects note with missing ancestor", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/auth.flow.md": validNote("auth.flow"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("missing ancestor") && e.includes("auth"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("reports multiple missing ancestors", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/a.b.c.md": validNote("a.b.c"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      const hierarchyErrors = result.errors.filter((e) => e.includes("missing ancestor"));
      expect(hierarchyErrors.some((e) => e.includes('"a.md"'))).toBe(true);
      expect(hierarchyErrors.some((e) => e.includes('"a.b.md"'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Schema enforcement
// ============================================================

describe("checkResolved — schema enforcement", () => {
  it("accepts closed schema with all children present", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/meta.md": validNote("meta"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [meta]\n",
      },
    });
    try {
      const schemaErrors = checkResolved(config).errors.filter((e) => e.includes("schema"));
      expect(schemaErrors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects unlisted child in closed schema", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/rogue.md": validNote("rogue"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("not in root.schema.yml children"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("allows unlisted child in namespace schema", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/meta.md": validNote("meta"),
        "vault/meta.rogue.md": validNote("meta.rogue"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [meta]\n",
        "vault/meta.schema.yml":
          "version: 1\nschemas:\n  - id: meta\n    parent: root\n    namespace: true\n    children: []\n",
      },
    });
    try {
      const schemaErrors = checkResolved(config).errors.filter((e) => e.includes("schema"));
      expect(schemaErrors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("reports missing child declared in schema", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ghost]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some(
          (e) => e.includes("lists child") && e.includes("ghost") && e.includes("does not exist"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports empty schema file", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/root.schema.yml": "version: 1\nschemas: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("empty or malformed"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports schema missing top-level id", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: not-root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some(
          (e) => e.includes("does not declare a schema with id") && e.includes("root"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Wikilinks
// ============================================================

describe("checkResolved — wikilinks", () => {
  it("accepts valid wikilink to existing note", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {}, "See [[alpha]]."),
        "vault/alpha.md": validNote("alpha"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("wikilink"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts aliased wikilink", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote(
          "root",
          "Root",
          "Root note.",
          "active",
          {},
          "See [[Alpha Display|alpha]].",
        ),
        "vault/alpha.md": validNote("alpha"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("wikilink"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts wikilink with valid heading", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote(
          "root",
          "Root",
          "Root note.",
          "active",
          {},
          "See [[beta#Section]].",
        ),
        "vault/beta.md": validNote("beta", "Beta", "Beta note.", "active", {}, "## Section\n"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [beta]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("wikilink"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects wikilink to nonexistent note", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {}, "See [[ghost]]."),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some(
          (e) => e.includes("wikilink") && e.includes("unknown note") && e.includes("ghost"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects wikilink with missing heading", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote(
          "root",
          "Root",
          "Root note.",
          "active",
          {},
          "See [[beta#Nonexistent]].",
        ),
        "vault/beta.md": validNote("beta"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [beta]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some((e) => e.includes("wikilink") && e.includes("missing heading")),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("ignores wikilinks inside code fences", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote(
          "root",
          "Root",
          "Root note.",
          "active",
          {},
          "```\n[[should-not-resolve]]\n```\n",
        ),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("wikilink"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("ignores wikilinks inside inline code", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote(
          "root",
          "Root",
          "Root note.",
          "active",
          {},
          "Use `[[should-not-resolve]]` for that.\n",
        ),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("wikilink"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Code refs
// ============================================================

describe("checkResolved — code refs", () => {
  it("accepts valid code ref to export function", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "src/mod.ts", symbol: "myFunction" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
        "src/mod.ts": "export function myFunction() { return 1; }\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts export class declaration", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "src/mod.ts", symbol: "MyClass" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
        "src/mod.ts": "export class MyClass {}\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts export const declaration", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "src/mod.ts", symbol: "myConst" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
        "src/mod.ts": "export const myConst = 42;\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects code ref with missing file", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "src/nonexistent.ts", symbol: "myFn" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref file does not exist"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects code ref with missing symbol", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "src/mod.ts", symbol: "nonExistentSymbol" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
        "src/mod.ts": "export function myFunction() { return 1; }\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref") && e.includes("not found"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects code ref that escapes repo root", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/ref.md": validNote("ref", "Ref", "Ref note.", "active", {
          code_refs: [{ file: "../../etc/passwd", symbol: "something" }],
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [ref]\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("code_ref escapes repo root"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("skips code refs for notes with invalid frontmatter", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/bad.md": `---\nid: bad\ntitle: Bad\ndesc: Bad note.\nstatus: invalid-status\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\ncode_refs:\n  - file: nonexistent.ts\n    symbol: missing\n---\n\nBad note.`,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      // Should have frontmatter errors but NOT code_ref errors
      expect(result.errors.some((e) => e.includes("frontmatter"))).toBe(true);
      expect(result.errors.some((e) => e.includes("code_ref"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Freshness
// ============================================================

describe("checkResolved — freshness", () => {
  it("accepts non-expired note", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {
          last_verified: "2026-05-13",
          ttl_days: 365,
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("freshness"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects expired note", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {
          last_verified: "2020-01-01",
          ttl_days: 1,
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("freshness expired"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("skips deprecated note freshness check", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "deprecated", {
          last_verified: "2020-01-01",
          ttl_days: 1,
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("freshness"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid last_verified date", () => {
    const noteContent = `---\nid: root\ntitle: Root\ndesc: Root note.\nstatus: active\nowner: tester@example.com\nlast_verified: not-a-date\nttl_days: 365\n---\n\nRoot note.`;
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": noteContent,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("invalid last_verified"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports number of days expired", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root", "Root", "Root note.", "active", {
          last_verified: "2020-01-01",
          ttl_days: 1,
        }),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      const freshnessError = result.errors.find((e) => e.includes("freshness expired"));
      expect(freshnessError).toBeDefined();
      expect(freshnessError?.match(/day\(s\) ago/)).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// External invariants
// ============================================================

describe("checkResolved — external invariants", () => {
  it("accepts note with both token and value", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/good.md": validNote(
          "good",
          "Good",
          "Good note.",
          "active",
          {},
          "Version is {{version}} and 2.0.0.\n",
        ),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [good]\n",
      },
    });
    config.externalInvariants = [{ id: "version", value: "2.0.0", usedIn: ["good"] }];
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("invariant"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects note missing the token", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/note.md": validNote("note", "Note", "Note.", "active", {}, "Version is 2.0.0.\n"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [note]\n",
      },
    });
    config.externalInvariants = [{ id: "version", value: "2.0.0", usedIn: ["note"] }];
    try {
      const result = checkResolved(config);
      expect(result.errors.some((e) => e.includes("missing invariant token {{version}}"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects note missing the value", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/note.md": validNote(
          "note",
          "Note",
          "Note.",
          "active",
          {},
          "Version is {{version}}.\n",
        ),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [note]\n",
      },
    });
    config.externalInvariants = [{ id: "version", value: "2.0.0", usedIn: ["note"] }];
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some(
          (e) => e.includes("value") && e.includes("2.0.0") && e.includes("not present"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports invariant referencing missing note", () => {
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    config.externalInvariants = [{ id: "version", value: "2.0.0", usedIn: ["ghost"] }];
    try {
      const result = checkResolved(config);
      expect(
        result.errors.some((e) => e.includes("references missing note") && e.includes("ghost")),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ============================================================
// Vault not found
// ============================================================

describe("checkResolved — vault not found", () => {
  it("returns vault-not-found error for non-existent directory", () => {
    const config = createResolvedConfig({
      vaultDir: "/nonexistent/path/that/does/not/exist",
      repoRoot: "/nonexistent/path/that/does/not/exist",
    });
    const result = checkResolved(config);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("vault directory not found");
    expect(result.noteCount).toBe(0);
  });
});

// ============================================================
// Accumulation of errors from multiple categories
// ============================================================

describe("checkResolved — error accumulation", () => {
  it("accumulates errors from all check categories", () => {
    const noteContent = `---\nid: wrong-id\ntitle: Wrong\ndesc: Mismatched id.\nstatus: active\nowner: tester@example.com\nlast_verified: 2020-01-01\nttl_days: 1\n---\n\nSee [[ghost]].`;
    const { config, cleanup } = setupValidVault({
      files: {
        "vault/root.md": validNote("root"),
        "vault/mismatch.md": noteContent,
        "vault/root.schema.yml":
          "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: []\n",
      },
    });
    try {
      const result = checkResolved(config);
      // Should have: id mismatch error + freshness expired error + wikilink error
      expect(result.errors.some((e) => e.includes("does not match filename id"))).toBe(true);
      expect(result.errors.some((e) => e.includes("freshness expired"))).toBe(true);
      expect(result.errors.some((e) => e.includes("wikilink") && e.includes("unknown note"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });
});
