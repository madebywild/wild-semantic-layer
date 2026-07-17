import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmpParent = join(repoRoot, ".tmp", "e2e");
const containerRoot = "/workspaces";
const fixtureLastVerified = new Date().toISOString().slice(0, 10);

let tmpRoot = "";

type ScenarioWorkspace = {
  containerDir: string;
  hostDir: string;
  name: string;
};

type ExecResult = Awaited<ReturnType<StartedTestContainer["exec"]>>;

type CodeRefsSidecar = {
  schema_version: number;
  refs: Array<{
    note_id: string;
    ref: {
      file: string;
      symbol: string;
      kind?: string;
      namespace?: string;
    };
    kind: string;
    namespaces: string[];
    line: number;
    column: number;
    declarations: Array<{
      file: string;
      kind: string;
      line: number;
      column: number;
    }>;
  }>;
};

describe("semantic-layer CLI blackbox", () => {
  let container: StartedTestContainer;
  let scenarios: {
    drift: ScenarioWorkspace;
    jsAgent: ScenarioWorkspace;
    monorepoTs: ScenarioWorkspace;
  };

  beforeAll(async () => {
    mkdirSync(tmpParent, { recursive: true });
    tmpRoot = mkdtempSync(join(tmpParent, "semantic-layer-blackbox-"));

    const packDir = join(tmpRoot, "pack");
    mkdirSync(packDir, { recursive: true });
    execFileSync(
      "pnpm",
      ["--filter", "@madebywild/semantic-layer", "pack", "--pack-destination", packDir],
      { cwd: repoRoot, stdio: "inherit" },
    );
    const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error("package tarball was not created");

    const workspacesDir = join(tmpRoot, "workspaces");
    scenarios = {
      monorepoTs: createConsumerWorkspace(
        workspacesDir,
        "monorepo-ts-service",
        tarball,
        monorepoTypeScriptFiles(),
      ),
      jsAgent: createConsumerWorkspace(
        workspacesDir,
        "simple-js-agent",
        tarball,
        simpleJsAgentFiles(),
      ),
      drift: createConsumerWorkspace(
        workspacesDir,
        "drift-and-migration",
        tarball,
        driftMigrationFiles(),
      ),
    };

    // LadybugDB ships a native module that requires glibc + OpenSSL 3, so
    // Alpine/musl is not supported and the slim image omits libssl. Use the
    // full Debian-based image for blackbox tests.
    container = await new GenericContainer("node:24")
      .withCommand(["sleep", "infinity"])
      .withCopyDirectoriesToContainer([{ source: workspacesDir, target: containerRoot }])
      .start();
  });

  afterAll(async () => {
    await container?.stop();
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it("validates monorepo TypeScript service docs with custom code-ref sidecar output", async () => {
    const workspace = scenarios.monorepoTs;
    await install(workspace);

    const check = await cli(workspace, ["check"]);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain("semantic-layer: ok (3 notes verified)");

    const index = await cli(workspace, ["index"]);
    expect(index.exitCode, index.output).toBe(0);
    expect(index.output).toContain("HIERARCHY.md");
    expect(index.output).toContain("generated/custom-code-refs.json");

    const hierarchy = await readText(workspace, "vault/HIERARCHY.md");
    expect(hierarchy).toContain("**service.auth**");

    const sidecar = await readJson<CodeRefsSidecar>(
      workspace,
      "vault/generated/custom-code-refs.json",
    );
    expect(sidecar.schema_version).toBe(1);
    expectStableRelativeSidecar(sidecar);

    const createSession = findRef(sidecar, "createSession");
    expect(createSession).toMatchObject({
      kind: "function",
      line: 4,
      note_id: "service.auth",
      ref: {
        file: "apps/api/src/service.ts",
        kind: "function",
        symbol: "createSession",
      },
    });
    expect(createSession?.declarations).toEqual([
      { column: 17, file: "apps/api/src/service.ts", kind: "function", line: 4 },
      { column: 17, file: "apps/api/src/service.ts", kind: "function", line: 5 },
      { column: 17, file: "apps/api/src/service.ts", kind: "function", line: 6 },
    ]);

    expect(findRef(sidecar, "normalizeClaims")).toMatchObject({
      kind: "function",
      line: 12,
      ref: {
        file: "apps/api/src/service.ts",
        kind: "function",
      },
    });
    expect(findRef(sidecar, "importedValidateIssuer")).toMatchObject({
      kind: "import",
      line: 1,
      ref: {
        file: "apps/api/src/service.ts",
        kind: "import",
        symbol: "importedValidateIssuer",
      },
      declarations: [
        { column: 28, file: "apps/api/src/service.ts", kind: "import", line: 1 },
        { column: 17, file: "packages/auth/src/policy.ts", kind: "function", line: 6 },
      ],
    });
    expect(findRef(sidecar, "exportedValidateIssuer")).toMatchObject({
      kind: "export",
      line: 2,
      ref: {
        file: "apps/api/src/service.ts",
        kind: "export",
        symbol: "exportedValidateIssuer",
      },
      declarations: [
        { column: 28, file: "apps/api/src/service.ts", kind: "export", line: 2 },
        { column: 17, file: "packages/auth/src/policy.ts", kind: "function", line: 6 },
      ],
    });
    expect(findRef(sidecar, "AuthPolicy")).toMatchObject({
      kind: "interface",
      namespaces: ["type"],
      ref: {
        file: "packages/auth/src/policy.ts",
        namespace: "type",
      },
    });
  });

  it("searches the vault and explores the graph via the CLI", async () => {
    // Reuses the monorepo workspace: it is installed and indexed by the test above.
    const workspace = scenarios.monorepoTs;

    const search = await cli(workspace, ["search", "authentication", "--mode", "fts"]);
    expect(search.exitCode, search.output).toBe(0);
    expect(search.output).toContain("service.auth");

    const searchJson = await cli(workspace, [
      "search",
      "authentication",
      "--mode",
      "fts",
      "--json",
    ]);
    expect(searchJson.exitCode, searchJson.output).toBe(0);
    const parsedSearch = JSON.parse(searchJson.output) as { hits: Array<{ noteId: string }> };
    expect(parsedSearch.hits.map((hit) => hit.noteId)).toContain("service.auth");

    const backlinks = await cli(workspace, ["graph", "backlinks", "service.auth", "--json"]);
    expect(backlinks.exitCode, backlinks.output).toBe(0);
    const parsedBacklinks = JSON.parse(backlinks.output) as { hits: Array<{ sourceId: string }> };
    expect(parsedBacklinks.hits.map((hit) => hit.sourceId)).toContain("service");

    const impact = await cli(workspace, [
      "graph",
      "impact",
      "--file",
      "apps/api/src/service.ts",
      "--json",
    ]);
    expect(impact.exitCode, impact.output).toBe(0);
    const parsedImpact = JSON.parse(impact.output) as { hits: Array<{ noteId: string }> };
    expect(parsedImpact.hits.map((hit) => hit.noteId)).toContain("service.auth");

    // Flag plumbing: full rebuild, the search-index alias, filters, --version, and default check.
    const fullRebuild = await cli(workspace, ["index", "--full"]);
    expect(fullRebuild.exitCode, fullRebuild.output).toBe(0);
    // The container has no working fastembed, so the suffix may be " (fts-only)".
    expect(fullRebuild.output).toMatch(/full( \(fts-only\))? rebuild/);

    const alias = await cli(workspace, ["search-index"]);
    expect(alias.exitCode, alias.output).toBe(0);
    expect(alias.output).toContain("rebuild");

    const filtered = await cli(workspace, [
      "search",
      "authentication",
      "--mode",
      "fts",
      "--status",
      "active",
    ]);
    expect(filtered.exitCode, filtered.output).toBe(0);
    expect(filtered.output).toContain("service.auth");

    const limited = await cli(workspace, ["search", "service", "--mode", "fts", "--limit", "1"]);
    expect(limited.exitCode, limited.output).toBe(0);
    expect(limited.output).toContain("1 hit(s)");

    const version = await cli(workspace, ["--version"]);
    expect(version.exitCode, version.output).toBe(0);

    const defaultCheck = await cli(workspace, []);
    expect(defaultCheck.exitCode, defaultCheck.output).toBe(0);
    expect(defaultCheck.output).toContain("semantic-layer: ok");

    // Missing arguments and invalid values must exit non-zero with a readable error.
    for (const args of [
      ["search"],
      ["graph"],
      ["graph", "nope"],
      ["graph", "impact"],
      ["search", "x", "--mode", "bogus"],
      ["search", "x", "--limit", "0"],
      ["nope"],
    ]) {
      const result = await cli(workspace, args);
      expect(result.exitCode, `expected failure for: ${args.join(" ")}`).not.toBe(0);
    }
  });

  it("runs the simple JavaScript consumer refinement lifecycle", async () => {
    const workspace = scenarios.jsAgent;
    await install(workspace);

    const help = await cli(workspace, ["--help"]);
    expect(help.exitCode, help.output).toBe(0);
    expect(help.output).toContain("Usage: semantic-layer <command> [options]");

    const check = await cli(workspace, ["check"]);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain("semantic-layer: ok (3 notes verified)");

    const index = await cli(workspace, ["index"]);
    expect(index.exitCode, index.output).toBe(0);
    expect(index.output).toContain("code-refs.json");
    expect(await readText(workspace, "vault/.semantic-layer/code-refs.json")).toContain(
      '"symbol": "issueToken"',
    );

    const staged = await cli(workspace, [
      "refine",
      "stage",
      "--source",
      "user-message",
      "--title",
      "Rename token issuer function",
      "--related",
      "service.auth",
      "--summary",
      "The service token issuer function should be renamed after the trusted source changes.",
    ]);
    expect(staged.exitCode, staged.output).toBe(0);
    const stagedId = parseStagedId(staged.output);

    const listed = await cli(workspace, ["refine", "list", "--status", "staged"]);
    expect(listed.exitCode, listed.output).toBe(0);
    expect(listed.output).toContain(`[staged] Rename token issuer function`);

    const stagedCheck = await cli(workspace, ["check"]);
    expect(stagedCheck.exitCode, stagedCheck.output).toBe(0);
    expect(stagedCheck.output).toContain("semantic-layer: ok (3 notes verified)");

    await replaceInRuntimeFile(workspace, "src/service.js", "issueToken", "issueSessionToken");

    const prematurePromote = await cli(workspace, [
      "refine",
      "promote",
      stagedId,
      "--note",
      "service.auth",
    ]);
    expect(prematurePromote.exitCode).not.toBe(0);
    expect(prematurePromote.output).toContain("semantic-layer check failed");
    expect(prematurePromote.output).toContain("code_ref src/service.js#issueToken not found");

    await replaceInRuntimeFile(
      workspace,
      "vault/service.auth.md",
      "symbol: issueToken",
      "symbol: issueSessionToken",
    );

    const promoted = await cli(workspace, [
      "refine",
      "promote",
      stagedId,
      "--note",
      "service.auth",
    ]);
    expect(promoted.exitCode, promoted.output).toBe(0);
    expect(promoted.output).toContain(`semantic-layer refine: promoted ${stagedId}`);
    expect(promoted.output).toContain("HIERARCHY.md");

    const promotedList = await cli(workspace, ["refine", "list", "--status", "promoted"]);
    expect(promotedList.exitCode, promotedList.output).toBe(0);
    expect(promotedList.output).toContain(`[promoted] Rename token issuer function`);

    const remainingStaged = await cli(workspace, ["refine", "list", "--status", "staged"]);
    expect(remainingStaged.exitCode, remainingStaged.output).toBe(0);
    expect(remainingStaged.output).toContain("semantic-layer refine: no refinements");

    const regenerated = await readText(workspace, "vault/.semantic-layer/code-refs.json");
    expect(regenerated).toContain('"symbol": "issueSessionToken"');
    expect(regenerated).not.toContain('"symbol": "issueToken"');
  });

  it("reports drift and migration failures without overwriting generated files", async () => {
    const workspace = scenarios.drift;
    await install(workspace);

    const check = await cli(workspace, ["check"]);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain("semantic-layer: ok (1 notes verified)");

    const index = await cli(workspace, ["index"]);
    expect(index.exitCode, index.output).toBe(0);
    const originalHierarchy = await readText(workspace, "vault/HIERARCHY.md");
    const originalSidecar = await readText(workspace, "vault/.semantic-layer/code-refs.json");
    expect(originalSidecar).toContain('"symbol": "stable"');

    await expectDriftFailure(workspace, {
      expected: "code_ref src/service.ts#missing not found",
      note: rootNoteWithCodeRefs([{ file: "src/service.ts", symbol: "missing" }], {
        title: "Missing symbol drift",
      }),
      originalHierarchy,
      originalSidecar,
    });

    await writeRuntimeFile(
      workspace,
      "src/service.ts",
      [
        "type Shared = string;",
        "export function makeShared() {",
        "  const Shared = 1;",
        "  return Shared;",
        "}",
        "",
      ].join("\n"),
    );
    await expectDriftFailure(workspace, {
      expected: "is ambiguous; add kind and/or namespace",
      note: rootNoteWithCodeRefs([{ file: "src/service.ts", symbol: "Shared" }], {
        title: "Ambiguous symbol drift",
      }),
      originalHierarchy,
      originalSidecar,
    });

    await writeRuntimeFile(workspace, "src/python_mod.py", "def python_helper():\n    return 1\n");
    await expectDriftFailure(workspace, {
      expected: "code_ref unsupported source type: src/python_mod.py",
      note: rootNoteWithCodeRefs([{ file: "src/python_mod.py", symbol: "python_helper" }], {
        title: "Unsupported source drift",
      }),
      originalHierarchy,
      originalSidecar,
    });

    await expectDriftFailure(workspace, {
      expected: "code_ref escapes repo root: ../outside.ts",
      note: rootNoteWithCodeRefs([{ file: "../outside.ts", symbol: "escapeRoot" }], {
        title: "Root escape drift",
      }),
      originalHierarchy,
      originalSidecar,
    });
  });

  async function install(workspace: ScenarioWorkspace) {
    const installResult = await run(workspace, [
      "npm",
      "install",
      "--no-audit",
      "--fund=false",
      "--prefer-offline",
      "--loglevel=error",
    ]);
    expect(installResult.exitCode, installResult.output).toBe(0);
  }

  async function cli(workspace: ScenarioWorkspace, args: string[]) {
    return run(workspace, ["npx", "semantic-layer", ...args]);
  }

  async function run(workspace: ScenarioWorkspace, command: string[]): Promise<ExecResult> {
    return container.exec(command, { workingDir: workspace.containerDir });
  }

  async function readText(workspace: ScenarioWorkspace, file: string): Promise<string> {
    const result = await run(workspace, ["cat", file]);
    expect(result.exitCode, result.output).toBe(0);
    return result.output;
  }

  async function readJson<T>(workspace: ScenarioWorkspace, file: string): Promise<T> {
    return JSON.parse(await readText(workspace, file)) as T;
  }

  async function writeRuntimeFile(workspace: ScenarioWorkspace, file: string, content: string) {
    const result = await run(workspace, [
      "node",
      "-e",
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const file = process.argv[1];",
        "fs.mkdirSync(path.dirname(file), { recursive: true });",
        "fs.writeFileSync(file, process.argv[2]);",
      ].join(" "),
      file,
      content,
    ]);
    expect(result.exitCode, result.output).toBe(0);
  }

  async function replaceInRuntimeFile(
    workspace: ScenarioWorkspace,
    file: string,
    search: string,
    replacement: string,
  ) {
    const content = await readText(workspace, file);
    expect(content).toContain(search);
    await writeRuntimeFile(workspace, file, content.replace(search, replacement));
  }

  async function expectDriftFailure(
    workspace: ScenarioWorkspace,
    options: {
      expected: string;
      note: string;
      originalHierarchy: string;
      originalSidecar: string;
    },
  ) {
    await writeRuntimeFile(workspace, "vault/root.md", options.note);

    const check = await cli(workspace, ["check"]);
    expect(check.exitCode).not.toBe(0);
    expect(check.output).toContain(options.expected);

    const index = await cli(workspace, ["index"]);
    expect(index.exitCode).not.toBe(0);
    expect(index.output).toContain(options.expected);
    expect(await readText(workspace, "vault/HIERARCHY.md")).toBe(options.originalHierarchy);
    expect(await readText(workspace, "vault/.semantic-layer/code-refs.json")).toBe(
      options.originalSidecar,
    );
  }
});

function createConsumerWorkspace(
  root: string,
  name: string,
  tarball: string,
  files: Record<string, string>,
): ScenarioWorkspace {
  const hostDir = join(root, name);
  mkdirSync(hostDir, { recursive: true });
  cpSync(join(tmpRoot, "pack", tarball), join(hostDir, tarball));
  writeFileSync(
    join(hostDir, "package.json"),
    JSON.stringify(
      {
        name: `semantic-layer-${name}`,
        private: true,
        type: "module",
        dependencies: {
          "@madebywild/semantic-layer": `file:./${tarball}`,
        },
      },
      null,
      2,
    ),
  );
  writeFiles(hostDir, files);
  return {
    containerDir: `${containerRoot}/${name}`,
    hostDir,
    name,
  };
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function monorepoTypeScriptFiles(): Record<string, string> {
  return {
    "semantic-layer.config.yml": `vault: vault
root: .
index:
  file: HIERARCHY.md
  codeRefsFile: generated/custom-code-refs.json
frontmatter:
  requiredExtraFields: [layer]
`,
    "apps/api/tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "../..",
          strict: true,
          target: "ES2022",
        },
        include: ["src/**/*.ts", "../../packages/auth/src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "apps/api/src/service.ts": [
      'import { validateIssuer as importedValidateIssuer, type AuthPolicy } from "../../../packages/auth/src/index.js";',
      'export { validateIssuer as exportedValidateIssuer } from "../../../packages/auth/src/index.js";',
      "",
      "export function createSession(policy: AuthPolicy, subject: string): string;",
      "export function createSession(policy: AuthPolicy, subject: string, scopes: string[]): string;",
      "export function createSession(policy: AuthPolicy, subject: string, scopes: string[] = []) {",
      "  const normalized = normalizeClaims(subject, scopes);",
      '  if (!importedValidateIssuer(policy)) throw new Error("invalid issuer");',
      '  return policy.issuer + ":" + normalized;',
      "}",
      "",
      "function normalizeClaims(subject: string, scopes: string[]) {",
      '  return [subject, ...scopes].filter(Boolean).join(":");',
      "}",
      "",
    ].join("\n"),
    "packages/auth/src/index.ts":
      'export { validateIssuer, type AuthPolicy } from "./policy.js";\n',
    "packages/auth/src/policy.ts": [
      "export interface AuthPolicy {",
      "  issuer: string;",
      "  audience: string;",
      "}",
      "",
      "export function validateIssuer(policy: AuthPolicy) {",
      '  return policy.issuer.startsWith("wild-");',
      "}",
      "",
    ].join("\n"),
    "vault/root.md": `${frontmatter("root", "Root", "Root note.")}\n# Root\n\nSee [[service]].\n`,
    "vault/service.md": `${frontmatter(
      "service",
      "Service",
      "Service docs.",
    )}\n# Service\n\nSee [[service.auth]].\n`,
    "vault/service.auth.md": `---
id: service.auth
title: Service auth
desc: TypeScript service authentication contract.
status: active
owner: test@wild.as
last_verified: ${fixtureLastVerified}
ttl_days: 365
layer: e2e
code_refs:
  - file: apps/api/src/service.ts
    symbol: createSession
    kind: function
  - file: apps/api/src/service.ts
    symbol: normalizeClaims
    kind: function
  - file: apps/api/src/service.ts
    symbol: importedValidateIssuer
    kind: import
  - file: apps/api/src/service.ts
    symbol: exportedValidateIssuer
    kind: export
  - file: packages/auth/src/policy.ts
    symbol: AuthPolicy
    kind: interface
    namespace: type
---

# Service auth

The API service imports and re-exports auth helpers from the shared package.
`,
    "vault/root.schema.yml": `version: 1
schemas:
  - id: root
    parent: root
    children: [service]
`,
    "vault/service.schema.yml": `version: 1
schemas:
  - id: service
    parent: root
    children: [auth]
`,
  };
}

function simpleJsAgentFiles(): Record<string, string> {
  return {
    "semantic-layer.config.yml": `vault: vault
root: .
frontmatter:
  requiredExtraFields: [layer]
externalInvariants:
  - id: issuer
    value: demo-issuer
    usedIn: [service.auth]
`,
    "src/service.js": `export function issueToken() {
  return "demo-issuer";
}
`,
    "vault/root.md": `${frontmatter("root", "Root", "Root note.")}\n# Root\n\nSee [[service]].\n`,
    "vault/service.md": `${frontmatter(
      "service",
      "Service",
      "Service notes.",
    )}\n# Service\n\nSee [[service.auth]].\n`,
    "vault/service.auth.md": `---
id: service.auth
title: Service auth
desc: Authentication contract.
status: active
owner: test@wild.as
last_verified: ${fixtureLastVerified}
ttl_days: 365
layer: e2e
code_refs:
  - file: src/service.js
    symbol: issueToken
    kind: function
---

# Service auth

The token issuer is demo-issuer and is tracked as {{issuer}}.
`,
    "vault/root.schema.yml": `version: 1
schemas:
  - id: root
    parent: root
    children: [service]
`,
    "vault/service.schema.yml": `version: 1
schemas:
  - id: service
    parent: root
    children: [auth]
`,
  };
}

function driftMigrationFiles(): Record<string, string> {
  return {
    "semantic-layer.config.yml": `vault: vault
root: .
`,
    "src/service.ts": "export function stable() { return 1; }\n",
    "vault/root.md": rootNoteWithCodeRefs([{ file: "src/service.ts", symbol: "stable" }]),
    "vault/root.schema.yml": `version: 1
schemas:
  - id: root
    parent: root
    children: []
`,
  };
}

function frontmatter(id: string, title: string, desc: string) {
  return `---
id: ${id}
title: ${title}
desc: ${desc}
status: active
owner: test@wild.as
last_verified: ${fixtureLastVerified}
ttl_days: 365
layer: e2e
---`;
}

function rootNoteWithCodeRefs(
  refs: Array<{ file: string; symbol: string }>,
  options: { desc?: string; title?: string } = {},
) {
  const codeRefs = refs.map((ref) => `  - file: ${ref.file}\n    symbol: ${ref.symbol}`).join("\n");
  return `---
id: root
title: ${options.title ?? "Root"}
desc: ${options.desc ?? "Root note."}
status: active
owner: test@wild.as
last_verified: ${fixtureLastVerified}
ttl_days: 365
code_refs:
${codeRefs}
---

# Root

Legacy code refs start with file and symbol only.
`;
}

function parseStagedId(output: string): string {
  const match = output.match(/semantic-layer refine: staged (\S+)/);
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? "";
}

function findRef(sidecar: CodeRefsSidecar, symbol: string) {
  const ref = sidecar.refs.find((candidate) => candidate.ref.symbol === symbol);
  expect(ref, `expected sidecar ref for ${symbol}`).toBeDefined();
  return ref;
}

function expectStableRelativeSidecar(sidecar: CodeRefsSidecar) {
  for (const ref of sidecar.refs) {
    expect(ref.ref.file).not.toMatch(/^\/|^\.\./);
    for (const declaration of ref.declarations) {
      expect(declaration.file).not.toMatch(/^\/|^\.\./);
      expect(declaration.file).not.toContain("/Users/");
      expect(declaration.file).not.toContain("/workspaces/");
    }
  }
}
