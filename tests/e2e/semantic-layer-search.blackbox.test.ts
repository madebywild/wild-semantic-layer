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

type Workspace = { containerDir: string; hostDir: string };
type ExecResult = Awaited<ReturnType<StartedTestContainer["exec"]>>;

/**
 * Alpine (musl) has no `fastembed` build, and thus no local embedder — this is exactly the
 * scenario `optionalDependencies` + the availability guard in `embedder.ts` exist for. Kept as
 * its own file (its own container) so it never touches the existing, currently-passing
 * `semantic-layer.blackbox.test.ts`.
 *
 * Case A verifies the documented degrade path end to end: install succeeds with no build
 * toolchain, `search-index` falls back to an FTS-only index with a clear warning (not a crash),
 * `search --mode fts` keeps working, and `search --mode vector` fails with an actionable message.
 *
 * Case B verifies the *other* half of the portability claim — that Orama itself, the CLI, and the
 * `gemini` provider's code path have no native-dependency problem on Alpine — without requiring a
 * real network call or API key in CI: with no Gemini credentials configured, `search-index`
 * must fail with the credential error specifically, not a native-loader crash. Reaching that
 * error means every non-network step (Orama, hybrid search wiring, the CLI itself) already ran
 * successfully on musl.
 */
describe("semantic-layer search CLI blackbox (Alpine/musl)", () => {
  let container: StartedTestContainer;
  let workspace: Workspace;

  beforeAll(async () => {
    mkdirSync(tmpParent, { recursive: true });
    tmpRoot = mkdtempSync(join(tmpParent, "semantic-layer-search-blackbox-"));

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
    workspace = createWorkspace(workspacesDir, packDir, tarball);

    container = await new GenericContainer("node:24-alpine")
      .withCommand(["sleep", "infinity"])
      .withCopyDirectoriesToContainer([{ source: workspacesDir, target: containerRoot }])
      .start();

    // Stock node:*-alpine ships without git; the incremental-rebuild check below needs it, and a
    // real vault normally lives in a git repo anyway.
    await run(["apk", "add", "--no-cache", "git"]);
    await run(["git", "init", "-q", "-b", "main"]);
    await run(["git", "config", "user.email", "test@example.com"]);
    await run(["git", "config", "user.name", "Test"]);
    await run(["git", "config", "commit.gpgsign", "false"]);

    const install = await run([
      "npm",
      "install",
      "--no-audit",
      "--fund=false",
      "--prefer-offline",
      "--loglevel=error",
    ]);
    expect(install.exitCode, install.output).toBe(0);

    const commit = await run(["git", "add", "-A"]);
    expect(commit.exitCode, commit.output).toBe(0);
    const commitMsg = await run(["git", "commit", "-q", "-m", "initial"]);
    expect(commitMsg.exitCode, commitMsg.output).toBe(0);
  });

  afterAll(async () => {
    await container?.stop();
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it("Case A: degrades to an FTS-only index with no build toolchain, instead of crashing", async () => {
    const build = await cli(["search-index"]);
    expect(build.exitCode, build.output).toBe(0);
    expect(build.output).toContain("fastembed is unavailable on this platform");
    // cli.ts formats this as "full (fts-only) rebuild", so check the pieces independently rather
    // than the literal contiguous phrase "full rebuild".
    expect(build.output).toContain("fts-only");
    expect(build.output).toContain("full");
    expect(build.output).toContain("rebuild");

    const ftsSearch = await cli(["search", "widgets", "--mode", "fts"]);
    expect(ftsSearch.exitCode, ftsSearch.output).toBe(0);
    expect(ftsSearch.output).toContain("widgets");

    const vectorSearch = await cli(["search", "widgets", "--mode", "vector"]);
    expect(vectorSearch.exitCode).not.toBe(0);
    expect(vectorSearch.output).toContain("FTS-only");
    expect(vectorSearch.output).not.toMatch(/mutex|libc\+\+abi|segmentation fault/i);
  });

  it("Case A (incremental): an edited note is picked up without a full rebuild, still FTS-only", async () => {
    await writeRuntimeFile(
      "vault/widgets.md",
      noteMarkdown("widgets", "Widgets", "Widgets note.", "Widgets are now purple and round.\n"),
    );
    const commit = await run(["git", "add", "-A"]);
    expect(commit.exitCode, commit.output).toBe(0);
    const commitMsg = await run(["git", "commit", "-q", "-m", "edit widgets"]);
    expect(commitMsg.exitCode, commitMsg.output).toBe(0);

    const rebuild = await cli(["search-index"]);
    expect(rebuild.exitCode, rebuild.output).toBe(0);
    expect(rebuild.output).toContain("incremental");
    expect(rebuild.output).toContain("1 changed");

    const search = await cli(["search", "purple", "--mode", "fts"]);
    expect(search.exitCode, search.output).toBe(0);
    expect(search.output).toContain("widgets");
  });

  it("Case B: the gemini provider path runs fully on Alpine up to the credential check — no native crash", async () => {
    await writeRuntimeFile(
      "semantic-layer.config.yml",
      "vault: vault\nroot: .\nsearch:\n  embedding:\n    provider: gemini\n",
    );

    const result = await cli(["search-index", "--full"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("requires an API key");
    expect(result.output).not.toMatch(/mutex|libc\+\+abi|segmentation fault|not found/i);
  });

  async function cli(args: string[]) {
    return run(["npx", "semantic-layer", ...args]);
  }

  async function run(command: string[]): Promise<ExecResult> {
    return container.exec(command, { workingDir: workspace.containerDir });
  }

  async function writeRuntimeFile(file: string, content: string) {
    const result = await run([
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
});

function createWorkspace(root: string, packDir: string, tarball: string): Workspace {
  const name = "search-vault";
  const hostDir = join(root, name);
  mkdirSync(hostDir, { recursive: true });
  cpSync(join(packDir, tarball), join(hostDir, tarball));
  writeFileSync(
    join(hostDir, "package.json"),
    JSON.stringify(
      {
        name: "semantic-layer-search-vault",
        private: true,
        type: "module",
        dependencies: { "@madebywild/semantic-layer": `file:./${tarball}` },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(hostDir, "semantic-layer.config.yml"), "vault: vault\nroot: .\n");
  mkdirSync(join(hostDir, "vault"), { recursive: true });
  writeFileSync(
    join(hostDir, "vault", "root.md"),
    noteMarkdown("root", "Root", "Vault root.", "See [[widgets]] and [[gadgets]].\n"),
  );
  writeFileSync(
    join(hostDir, "vault", "root.schema.yml"),
    "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [widgets, gadgets]\n",
  );
  writeFileSync(
    join(hostDir, "vault", "widgets.md"),
    noteMarkdown("widgets", "Widgets", "Widgets note.", "Widgets are small and blue.\n"),
  );
  writeFileSync(
    join(hostDir, "vault", "gadgets.md"),
    noteMarkdown("gadgets", "Gadgets", "Gadgets note.", "Gadgets are large and green.\n"),
  );
  return { containerDir: `${containerRoot}/${name}`, hostDir };
}

function noteMarkdown(id: string, title: string, desc: string, body: string): string {
  return `---
id: ${id}
title: ${title}
desc: ${desc}
status: active
owner: test@wild.as
last_verified: ${fixtureLastVerified}
ttl_days: 365
---

# ${title}

${body}`;
}
