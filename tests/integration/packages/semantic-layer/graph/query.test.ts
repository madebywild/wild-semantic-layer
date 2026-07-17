import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runGraph } from "../../../../../packages/semantic-layer/src/commands/graph.js";
import { buildIndex } from "../../../../../packages/semantic-layer/src/db/indexer.js";
import {
  ancestors,
  backlinks,
  codeImpact,
  cycles,
  descendants,
  forwardLinks,
  orphans,
  relatedNotes,
} from "../../../../../packages/semantic-layer/src/db/queries/graph.js";
import {
  createFakeEmbedder,
  createResolvedConfig,
  createTempVault,
  gitCommitAll,
  initGitRepo,
  type TempVault,
} from "../../../../helpers.js";

function note(
  id: string,
  options: { body?: string; tags?: string[]; codeRefs?: { file: string; symbol: string }[] } = {},
): string {
  const tags = options.tags ? `tags: [${options.tags.join(", ")}]\n` : "";
  const codeRefs = options.codeRefs
    ? `code_refs:\n${options.codeRefs.map((ref) => `  - file: ${ref.file}\n    symbol: ${ref.symbol}\n`).join("")}`
    : "";
  return `---\nid: ${id}\ntitle: ${id} title\ndesc: ${id} note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n${tags}${codeRefs}---\n\n# ${id}\n\n${options.body ?? `Content of ${id}.`}\n`;
}

const SERVICE_TS =
  "export function issueToken() { return 'token'; }\nexport function revokeToken() { return null; }\n";

function createGraphVault(): TempVault {
  return createTempVault({
    "vault/root.md": note("root", { body: "# root\n\nStart at [[guide]].\n" }),
    "vault/guide.md": note("guide", {
      body: "# guide\n\nSee [[api#tokens]] and [[root.alpha]].\n",
      tags: ["docs"],
    }),
    "vault/api.md": note("api", {
      tags: ["docs", "code"],
      codeRefs: [
        { file: "src/service.ts", symbol: "issueToken" },
        { file: "src/service.ts", symbol: "revokeToken" },
      ],
    }),
    "vault/impl.md": note("impl", {
      body: "# impl\n\nImplements [[api]].\n",
      tags: ["code", "docs"],
      codeRefs: [{ file: "src/service.ts", symbol: "issueToken" }],
    }),
    "vault/root.alpha.md": note("root.alpha", {
      body: "# root.alpha\n\nDetails in [[root.alpha.one]].\n",
    }),
    "vault/root.alpha.one.md": note("root.alpha.one"),
    "vault/lonely.md": note("lonely"),
    "vault/c1.md": note("c1", { body: "# c1\n\nNext [[c2]].\n" }),
    "vault/c2.md": note("c2", { body: "# c2\n\nNext [[c3]].\n" }),
    "vault/c3.md": note("c3", { body: "# c3\n\nBack to [[c1]].\n" }),
    "vault/loop.md": note("loop", { body: "# loop\n\nSelf [[loop]].\n" }),
    "vault/root.schema.yml":
      "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [guide, api, impl, root.alpha, lonely, c1, c2, c3, loop]\n",
    "src/service.ts": SERVICE_TS,
  });
}

async function setupIndexedVault(): Promise<{
  tv: TempVault;
  config: ReturnType<typeof createResolvedConfig>;
}> {
  const tv = createGraphVault();
  initGitRepo(tv.dir);
  gitCommitAll(tv.dir, "initial");
  const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
  await buildIndex(config, {}, { embedder: createFakeEmbedder() });
  return { tv, config };
}

// buildIndex is slow (schema + extensions + TS code-ref resolution), so the
// whole file shares one indexed vault; tests only run read-only queries.
// Tests that need a different index state (stale meta, missing DB) build or
// skip their own vaults.
let shared: { tv: TempVault; config: ReturnType<typeof createResolvedConfig> };

beforeAll(async () => {
  shared = await setupIndexedVault();
});

afterAll(() => {
  shared.tv.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("graph queries", () => {
  it("backlinks returns notes linking to a note, with anchors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hits = await backlinks(shared.config, "api");
    expect(hits).toEqual([
      { sourceId: "guide", sourceTitle: "guide title", anchor: "tokens", status: "active" },
      { sourceId: "impl", sourceTitle: "impl title", status: "active" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("backlinks honors limit", async () => {
    const hits = await backlinks(shared.config, "api", { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceId).toBe("guide");
  });

  it("forwardLinks returns outgoing wikilink targets", async () => {
    const hits = await forwardLinks(shared.config, "guide");
    expect(hits).toEqual([
      { targetId: "api", targetTitle: "api title", anchor: "tokens", status: "active" },
      { targetId: "root.alpha", targetTitle: "root.alpha title", status: "active" },
    ]);
  });

  it("descendants walks the hierarchy with depth", async () => {
    const hits = await descendants(shared.config, "root");
    expect(hits).toEqual([
      { id: "root.alpha", title: "root.alpha title", depth: 1, status: "active" },
      { id: "root.alpha.one", title: "root.alpha.one title", depth: 2, status: "active" },
    ]);
  });

  it("descendants honors a depth bound", async () => {
    const hits = await descendants(shared.config, "root", { depth: 1 });
    expect(hits).toEqual([
      { id: "root.alpha", title: "root.alpha title", depth: 1, status: "active" },
    ]);
  });

  it("ancestors walks the hierarchy upwards", async () => {
    const hits = await ancestors(shared.config, "root.alpha.one");
    expect(hits).toEqual([
      { id: "root.alpha", title: "root.alpha title", depth: 1, status: "active" },
      { id: "root", title: "root title", depth: 2, status: "active" },
    ]);
  });

  it("orphans returns notes without links or code refs, excluding root", async () => {
    const hits = await orphans(shared.config);
    expect(hits).toEqual([{ id: "lonely", title: "lonely title", status: "active" }]);
  });

  it("relatedNotes ranks by shared tags then common backlinks", async () => {
    const hits = await relatedNotes(shared.config, "api");
    expect(hits).toEqual([
      { id: "impl", title: "impl title", sharedTags: ["code", "docs"], commonBacklinks: 0 },
      { id: "guide", title: "guide title", sharedTags: ["docs"], commonBacklinks: 0 },
      { id: "root.alpha", title: "root.alpha title", sharedTags: [], commonBacklinks: 1 },
    ]);

    const limited = await relatedNotes(shared.config, "api", { limit: 2 });
    expect(limited.map((hit) => hit.id)).toEqual(["impl", "guide"]);
  });

  it("codeImpact filters by file only", async () => {
    const hits = await codeImpact(shared.config, { file: "src/service.ts" });
    expect(hits).toHaveLength(3);
    expect(hits.map((hit) => [hit.noteId, hit.symbol])).toEqual([
      ["api", "issueToken"],
      ["api", "revokeToken"],
      ["impl", "issueToken"],
    ]);
    expect(hits[0]).toMatchObject({ file: "src/service.ts", kind: "function" });
  });

  it("codeImpact filters by file and symbol", async () => {
    const hits = await codeImpact(shared.config, {
      file: "src/service.ts",
      symbol: "issueToken",
    });
    expect(hits.map((hit) => hit.noteId)).toEqual(["api", "impl"]);
  });

  it("codeImpact filters by symbol only", async () => {
    const hits = await codeImpact(shared.config, { symbol: "revokeToken" });
    expect(hits.map((hit) => [hit.noteId, hit.file])).toEqual([["api", "src/service.ts"]]);
  });

  it("cycles detects elementary link cycles including self-loops", async () => {
    const hits = await cycles(shared.config);
    expect(hits).toEqual([{ path: ["c1", "c2", "c3", "c1"] }, { path: ["loop", "loop"] }]);

    const limited = await cycles(shared.config, { limit: 1 });
    expect(limited).toEqual([{ path: ["c1", "c2", "c3", "c1"] }]);
  });

  it("rejects invalid limit and depth options", async () => {
    await expect(backlinks(shared.config, "api", { limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(descendants(shared.config, "root", { depth: -1 })).rejects.toThrow(
      /positive integer/,
    );
  });

  it("warns when the index meta is stale", async () => {
    // Separate vault: tampering with the shared meta would break other tests.
    const { tv, config } = await setupIndexedVault();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const metaFile = join(tv.vaultDir, ".semantic-layer", "vault.lbug.meta.json");
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { schemaVersion: number };
      meta.schemaVersion = 999;
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));

      const hits = await orphans(config);
      expect(hits).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/stale/);
      expect(warn.mock.calls[0]?.[0]).toMatch(/semantic-layer index/);
    } finally {
      tv.cleanup();
    }
  });

  it("throws a clear error when the index is missing", async () => {
    const tv = createGraphVault();
    try {
      const config = createResolvedConfig({ repoRoot: tv.dir, vaultDir: tv.vaultDir });
      await expect(orphans(config)).rejects.toThrow(/semantic-layer index/);
    } finally {
      tv.cleanup();
    }
  });
});

describe("runGraph", () => {
  it("dispatches subcommands to the graph queries", async () => {
    const result = await runGraph({ cwd: shared.tv.dir, subcommand: "backlinks", noteId: "api" });
    expect(result.subcommand).toBe("backlinks");
    expect(result.hits).toHaveLength(2);

    const impact = await runGraph({
      cwd: shared.tv.dir,
      subcommand: "impact",
      symbol: "issueToken",
    });
    expect(impact.subcommand).toBe("impact");
    expect(impact.hits).toHaveLength(2);
  });

  it("dispatches every note-scoped and vault-wide subcommand", async () => {
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ["links", { noteId: "guide" }, 2],
      ["descendants", { noteId: "root" }, 2],
      ["ancestors", { noteId: "root.alpha.one" }, 2],
      ["orphans", {}, 1],
      ["related", { noteId: "api" }, 3],
      ["cycles", {}, 2],
      ["impact", { file: "src/service.ts" }, 3],
    ];
    for (const [subcommand, extra, expectedHits] of cases) {
      const result = await runGraph({ cwd: shared.tv.dir, subcommand, ...extra });
      expect(result.subcommand).toBe(subcommand);
      expect(result.hits, subcommand).toHaveLength(expectedHits);
    }
  });

  it("requires a note id for note-scoped subcommands", async () => {
    await expect(runGraph({ cwd: shared.tv.dir, subcommand: "backlinks" })).rejects.toThrow(
      /requires a note id/,
    );
  });

  it("requires a file or symbol for impact", async () => {
    await expect(runGraph({ cwd: shared.tv.dir, subcommand: "impact" })).rejects.toThrow(
      /requires --file and\/or --symbol/,
    );
  });

  it("rejects unknown subcommands", async () => {
    await expect(runGraph({ cwd: shared.tv.dir, subcommand: "nope" })).rejects.toThrow(
      /Unknown graph subcommand/,
    );
  });

  it("refuses to run when search is disabled", async () => {
    // The enabled gate fires before any database access, so no index is needed for this test.
    const config = createResolvedConfig({
      search: { ...createResolvedConfig().search, enabled: false },
    });
    await expect(orphans(config)).rejects.toThrow(/search is disabled/);
  });
});
