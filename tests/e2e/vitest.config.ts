import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "e2e",
    include: ["**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
