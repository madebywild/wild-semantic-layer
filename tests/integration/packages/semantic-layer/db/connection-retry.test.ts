import { existsSync, writeFileSync } from "node:fs";
import type { Database } from "@ladybugdb/core";
import { describe, expect, it, vi } from "vitest";
import { openDatabaseWithRetry } from "../../../../../packages/semantic-layer/src/db/connection.js";
import { createTempDir } from "../../../../helpers.js";

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

  it("removes an orphaned WAL file whose database is gone, then opens fresh", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      // Crash debris: a WAL file with no main database file behind it.
      const dbPath = `${dir}/vault.lbug`;
      writeFileSync(`${dbPath}.wal`, "stale wal bytes");
      const open = vi
        .fn<(dbPath: string) => Database>()
        .mockImplementationOnce(() => {
          throw new Error(`Error renaming file ${dbPath}.wal to ${dbPath}.wal.checkpoint`);
        })
        .mockReturnValueOnce({} as Database);

      await openDatabaseWithRetry(dbPath, 3, 1, open);
      expect(open).toHaveBeenCalledTimes(2);
      expect(existsSync(`${dbPath}.wal`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("never deletes the WAL file while the database file exists", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      // The transient race on a LIVE database: the WAL must be left alone — deleting it here
      // would be data loss.
      const dbPath = `${dir}/vault.lbug`;
      writeFileSync(dbPath, "main db bytes");
      writeFileSync(`${dbPath}.wal`, "live wal bytes");
      const open = vi
        .fn<(dbPath: string) => Database>()
        .mockImplementationOnce(() => {
          throw new Error("IO error: could not rename WAL file during checkpoint");
        })
        .mockReturnValueOnce({} as Database);

      await openDatabaseWithRetry(dbPath, 3, 1, open);
      expect(existsSync(`${dbPath}.wal`)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
