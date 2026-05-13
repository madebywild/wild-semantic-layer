import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
