import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "tests/unit/vitest.config.ts",
      "tests/integration/vitest.config.ts",
      "tests/e2e/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      allowExternal: true,
      include: ["packages/semantic-layer/src/**/*.ts"],
      exclude: ["packages/semantic-layer/src/index.ts", "packages/semantic-layer/src/cli.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 95,
        lines: 90,
      },
    },
  },
});
