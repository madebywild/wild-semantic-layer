import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "unit",
    include: ["**/*.test.ts"],
    testTimeout: 5_000,
    hookTimeout: 10_000,
  },
});
