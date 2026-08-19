import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Index tests share process-local SQLite caches and filesystem fixtures. Run files
    // sequentially to keep isolation and failure diagnostics deterministic.
    fileParallelism: false,
  },
});
