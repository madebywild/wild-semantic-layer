import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // LadybugDB 0.18.2's native close is not fully synchronous; concurrent test files opening
    // and closing different databases in the same process race on WAL checkpointing and corrupt
    // each other. Run files sequentially to keep the database lifecycle stable.
    fileParallelism: false,
  },
});
