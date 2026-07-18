import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the source-level integration suite inside an isolated Linux container.
 *
 * Why this exists in addition to the plain host run (`vitest run --project=integration`):
 * - Environment parity: `@ladybugdb/core` is a glibc + OpenSSL 3 native module; consumers and CI
 *   run it on Debian-based Linux, and this proves the suite on exactly that platform.
 * - Guaranteed cleanup: several integration tests deliberately leave their temp vaults behind
 *   (deleting a LadybugDB directory mid-WAL-checkpoint can race the filesystem); inside the
 *   container all of that debris vanishes with the container instead of accumulating on the host.
 * - Host isolation: the native module's process-level quirks cannot touch the developer machine.
 *
 * Cleanup guarantees: `container.stop()` in afterAll removes the container (testcontainers stops
 * with remove enabled by default), and testcontainers' Ryuk resource reaper removes it even when
 * the process crashes or is killed before afterAll runs. The host-side staging copy is removed
 * in afterAll as well.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Staging lives OUTSIDE the repo: cpSync refuses to copy a directory into a subdirectory of
// itself, regardless of the exclusion filter.
const tmpParent = join(tmpdir(), "semantic-layer-integration-container");
const containerRepo = "/repo";

// The pnpm version is read from the workspace's packageManager field so the container resolves
// the lockfile with exactly the pnpm the host pins — a hand-typed copy would silently drift.
const PNPM_VERSION = (() => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const version = pkg.packageManager?.match(/^pnpm@(.+)$/)?.[1];
  if (!version) throw new Error("package.json packageManager must pin a pnpm version");
  return version;
})();

// Basenames never copied into the container: host-native dependencies (the host node_modules is
// a different platform's build), VCS internals, prior staging/coverage output, build output, and
// generated LadybugDB artifacts (the suite must build its own indexes from scratch).
const EXCLUDED_BASENAMES = new Set([
  "node_modules",
  ".git",
  ".tmp",
  "coverage",
  "dist",
  ".pnpm-store",
  "vault.lbug",
  "vault.lbug.wal",
  "vault.lbug.meta.json",
  "vault.lbug.meta.json.tmp",
]);

let stagingRoot = "";
let container: StartedTestContainer;

describe("integration suite in an isolated container", () => {
  beforeAll(async () => {
    mkdirSync(tmpParent, { recursive: true });
    stagingRoot = mkdtempSync(join(tmpParent, "run-"));
    const stagedRepo = join(stagingRoot, "repo");
    cpSync(repoRoot, stagedRepo, {
      recursive: true,
      filter: (source) => !EXCLUDED_BASENAMES.has(basename(source)),
    });

    // Same image as the e2e blackbox suite (one pull serves both): LadybugDB needs glibc +
    // OpenSSL 3, so the full Debian-based image is required — Alpine/musl and slim are out.
    container = await new GenericContainer("node:24")
      .withCommand(["sleep", "infinity"])
      .withCopyDirectoriesToContainer([{ source: stagedRepo, target: containerRepo }])
      .start();

    const pnpmInstall = await container.exec(["npm", "install", "-g", `pnpm@${PNPM_VERSION}`]);
    expect(pnpmInstall.exitCode, pnpmInstall.output).toBe(0);

    const install = await container.exec(["pnpm", "install", "--frozen-lockfile"], {
      workingDir: containerRepo,
    });
    expect(install.exitCode, install.output).toBe(0);
  });

  afterAll(async () => {
    // stop() removes the container; Ryuk covers crash paths where this never runs.
    await container?.stop();
    if (stagingRoot) rmSync(stagingRoot, { force: true, recursive: true });
  });

  it("passes the full integration project on Linux/glibc", async () => {
    // `--project=integration` matches that project name exactly, so this wrapper project can
    // never recurse into itself inside the container.
    const result = await container.exec(
      ["pnpm", "exec", "vitest", "run", "--project=integration"],
      // NO_COLOR keeps the summary assertable: with colors on, ANSI escapes sit between
      // "Test Files" and the count and break the regex below.
      { workingDir: containerRepo, env: { CI: "true", NO_COLOR: "1" } },
    );
    expect(result.exitCode, result.output).toBe(0);
    // Exit code is authoritative; this pins that a real vitest run produced the summary (an
    // early crash before any test ran would also exit non-zero, but be explicit).
    expect(result.output).toMatch(/Test Files\s+\d+ passed/);
  });
});
