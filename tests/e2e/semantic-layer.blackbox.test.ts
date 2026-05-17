import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmpRoot = join(repoRoot, ".tmp", "e2e");

describe("semantic-layer CLI blackbox", () => {
  let container: StartedTestContainer;
  let workDir: string;

  beforeAll(async () => {
    rmSync(tmpRoot, { force: true, recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    workDir = join(tmpRoot, "consumer");
    mkdirSync(workDir, { recursive: true });

    const packDir = join(tmpRoot, "pack");
    mkdirSync(packDir, { recursive: true });
    execFileSync(
      "pnpm",
      ["--filter", "@madebywild/semantic-layer", "pack", "--pack-destination", packDir],
      { cwd: repoRoot, stdio: "inherit" },
    );
    const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error("package tarball was not created");
    cpSync(join(packDir, tarball), join(workDir, tarball));

    writeConsumerProject(workDir, tarball);

    container = await new GenericContainer("node:24-alpine")
      .withCommand(["sleep", "infinity"])
      .withCopyDirectoriesToContainer([{ source: workDir, target: "/workspace" }])
      .start();
  });

  afterAll(async () => {
    await container?.stop();
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it("installs the packed package and validates a consumer vault", async () => {
    const install = await container.exec(["npm", "install", "--silent"], {
      workingDir: "/workspace",
    });
    expect(install.exitCode, install.output).toBe(0);

    const help = await container.exec(["npx", "semantic-layer", "--help"], {
      workingDir: "/workspace",
    });
    expect(help.exitCode, help.output).toBe(0);
    expect(help.output).toContain("Usage: semantic-layer <command> [options]");

    const check = await container.exec(["npx", "semantic-layer", "check"], {
      workingDir: "/workspace",
    });
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain("semantic-layer: ok (3 notes verified)");

    const index = await container.exec(["npx", "semantic-layer", "index"], {
      workingDir: "/workspace",
    });
    expect(index.exitCode, index.output).toBe(0);
    expect(index.output).toContain("HIERARCHY.md");

    const staged = await container.exec(
      [
        "npx",
        "semantic-layer",
        "refine",
        "stage",
        "--source",
        "user-message",
        "--title",
        "Issuer refinement",
        "--related",
        "service.auth",
        "--summary",
        "The service auth issuer contract may need refinement.",
      ],
      { workingDir: "/workspace" },
    );
    expect(staged.exitCode, staged.output).toBe(0);
    expect(staged.output).toContain("semantic-layer refine: staged");

    const listed = await container.exec(["npx", "semantic-layer", "refine", "list"], {
      workingDir: "/workspace",
    });
    expect(listed.exitCode, listed.output).toBe(0);
    expect(listed.output).toContain("[staged] Issuer refinement");

    const broken = await container.exec(
      [
        "sh",
        "-lc",
        "sed -i 's/symbol: issueToken/symbol: missingToken/' vault/service.auth.md && npx semantic-layer check",
      ],
      { workingDir: "/workspace" },
    );
    expect(broken.exitCode).not.toBe(0);
    expect(broken.output).toContain("code_ref src/service.js#missingToken not found");
  });
});

function writeConsumerProject(dir: string, tarball: string) {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "vault"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "semantic-layer-consumer",
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
  writeFileSync(
    join(dir, "semantic-layer.config.yml"),
    `vault: vault
root: .
frontmatter:
  requiredExtraFields: [layer]
externalInvariants:
  - id: issuer
    value: demo-issuer
    usedIn: [service.auth]
`,
  );
  writeFileSync(
    join(dir, "src/service.js"),
    `export function issueToken() {
  return "demo-issuer";
}
`,
  );
  writeFileSync(
    join(dir, "vault/root.md"),
    `${frontmatter("root", "Root", "Root note.")}\n# Root\n\nSee [[service]].\n`,
  );
  writeFileSync(
    join(dir, "vault/service.md"),
    `${frontmatter("service", "Service", "Service notes.")}\n# Service\n\nSee [[service.auth]].\n`,
  );
  writeFileSync(
    join(dir, "vault/service.auth.md"),
    `---
id: service.auth
title: Service auth
desc: Authentication contract.
status: active
owner: test@wild.as
last_verified: 2026-05-13
ttl_days: 365
layer: e2e
code_refs:
  - file: src/service.js
    symbol: issueToken
---

# Service auth

The token issuer is demo-issuer and is tracked as {{issuer}}.
`,
  );
  writeFileSync(
    join(dir, "vault/root.schema.yml"),
    `version: 1
schemas:
  - id: root
    parent: root
    children: [service]
`,
  );
  writeFileSync(
    join(dir, "vault/service.schema.yml"),
    `version: 1
schemas:
  - id: service
    parent: root
    children: [auth]
`,
  );
}

function frontmatter(id: string, title: string, desc: string) {
  return `---
id: ${id}
title: ${title}
desc: ${desc}
status: active
owner: test@wild.as
last_verified: 2026-05-13
ttl_days: 365
layer: e2e
---`;
}
