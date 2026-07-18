import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration-container",
    include: ["**/*.test.ts"],
    // One test boots a container, installs the workspace, and runs the whole integration suite
    // inside it: the budget covers an image pull on a cold machine plus a full pnpm install.
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
