import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTempVault, noteMarkdown } from "../../../../helpers.js";

const REAL_FASTEMBED_ENV = "SEMANTIC_LAYER_TEST_REAL_FASTEMBED";
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/semantic-layer",
);

/**
 * Once fastembed's native ONNX session is loaded, calling `process.exit()` crashes the process
 * (a native mutex error during teardown) with a non-zero exit code, even when the command's own
 * work succeeded — this can only be observed by spawning a real subprocess and checking its exit
 * status, which is why this lives here (gated, opt-in) rather than as an in-process test.
 */
describe.skipIf(!process.env[REAL_FASTEMBED_ENV])(
  "semantic-layer CLI — exits cleanly after loading a real fastembed model (opt-in, network + ONNX required)",
  () => {
    it("search-index and search both exit 0 instead of crashing on teardown", () => {
      execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "ignore" });

      const tv = createTempVault({
        "vault/root.md": noteMarkdown({ id: "root", body: "# Root\n" }),
        "vault/alpha.md": noteMarkdown({ id: "alpha", body: "## Section\n\nWidgets galore.\n" }),
      });
      try {
        const cliPath = resolve(packageRoot, "dist/cli.js");
        const runCli = (args: string[]) =>
          execFileSync("node", [cliPath, ...args], { cwd: tv.dir, encoding: "utf8" });

        // execFileSync throws if the subprocess exits non-zero, so simply not throwing here is
        // the actual assertion — this is exactly the class of failure a mocked/in-process test
        // cannot observe, since `process.exit()` never runs in-process.
        const buildOutput = runCli(["search-index"]);
        expect(buildOutput).toContain("full rebuild");

        const searchOutput = runCli(["search", "widgets", "--mode", "hybrid"]);
        expect(searchOutput).toContain("alpha");
      } finally {
        tv.cleanup();
      }
    }, 120_000);
  },
);
