#!/usr/bin/env node
import("../dist/cli.js").catch((error) => {
  console.error(
    "semantic-layer: built CLI not found. Run `pnpm --filter @madebywild/semantic-layer build` first.",
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
