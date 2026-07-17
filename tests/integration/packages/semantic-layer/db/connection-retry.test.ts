import type { Database } from "../../../../../packages/semantic-layer/node_modules/@ladybugdb/core";
import { describe, expect, it, vi } from "vitest";
import { openDatabaseWithRetry } from "../../../../../packages/semantic-layer/src/db/connection.js";

// Drives the retry policy through the `open` seam: no native module, no filesystem, and a 1ms
// delay so the suite stays fast.
describe("openDatabaseWithRetry", () => {
  it("retries a transient WAL checkpoint race and then succeeds", async () => {
    const open = vi
      .fn<(dbPath: string) => Database>()
      .mockImplementationOnce(() => {
        throw new Error("IO error: could not rename WAL file during checkpoint");
      })
      .mockReturnValueOnce({} as Database);

    const db = await openDatabaseWithRetry("/tmp/x/vault.lbug", 3, 1, open);
    expect(db).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not retry errors unrelated to the WAL race", async () => {
    const open = vi.fn<(dbPath: string) => Database>().mockImplementation(() => {
      throw new Error("permission denied");
    });

    await expect(openDatabaseWithRetry("/tmp/x/vault.lbug", 3, 1, open)).rejects.toThrow(
      /permission denied/,
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and throws the last error", async () => {
    const open = vi.fn<(dbPath: string) => Database>().mockImplementation(() => {
      throw new Error("wal still locked");
    });

    await expect(openDatabaseWithRetry("/tmp/x/vault.lbug", 3, 1, open)).rejects.toThrow(
      /wal still locked/,
    );
    expect(open).toHaveBeenCalledTimes(3);
  });
});
