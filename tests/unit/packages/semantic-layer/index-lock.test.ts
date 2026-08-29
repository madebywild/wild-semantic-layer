import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
  IndexLockError,
  indexLockFileForConfig,
  withIndexLock,
} from "../../../../packages/semantic-layer/src/index-lock.js";
import type { ResolvedConfig } from "../../../../packages/semantic-layer/src/types.js";
import { createResolvedConfig, createTempDir } from "../../../helpers.js";

type LockHolderFile = {
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
};

function configFor(dir: string): ResolvedConfig {
  return createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/vault` });
}

function writeLockFile(config: ResolvedConfig, holder: Partial<LockHolderFile> | string): void {
  const lockFile = indexLockFileForConfig(config);
  writeFileSync(
    lockFile,
    typeof holder === "string"
      ? holder
      : JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          command: "semantic-layer index",
          ...holder,
        }),
  );
}

/** Spawns a process that stays alive until killed, so a lock file can name a live pid. */
function spawnLivePid(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("failed to spawn a live holder process");
  return { pid: child.pid, kill: () => child.kill("SIGKILL") };
}

/** Returns the pid of a process that has already exited, so its lock counts as stale. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn a short-lived process");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  return pid;
}

describe("index lock", () => {
  it("holds the lock file for the duration of the run and releases it after", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      const lockFile = indexLockFileForConfig(config);
      const seen = await withIndexLock(config, () => {
        const holder = JSON.parse(readFileSync(lockFile, "utf8")) as LockHolderFile;
        return holder.pid;
      });
      expect(seen).toBe(process.pid);
      expect(lockFile).toBe(`${dir}/vault/.semantic-layer/index.lock`);
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("releases the lock when the guarded work throws", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await expect(
        withIndexLock(config, () => {
          throw new Error("index failed");
        }),
      ).rejects.toThrow("index failed");
      expect(existsSync(indexLockFileForConfig(config))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reuses the held lock for nested runs on the same vault", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      const value = await withIndexLock(config, () => withIndexLock(config, () => 42));
      expect(value).toBe(42);
      expect(existsSync(indexLockFileForConfig(config))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("locks each vault independently", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const outer = configFor(dir);
      const inner = createResolvedConfig({ repoRoot: dir, vaultDir: `${dir}/other-vault` });
      const held = await withIndexLock(outer, () =>
        withIndexLock(inner, () => existsSync(indexLockFileForConfig(outer))),
      );
      expect(held).toBe(true);
      expect(existsSync(indexLockFileForConfig(inner))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("fails fast while another live process holds the lock", async () => {
    const { dir, cleanup } = createTempDir();
    const live = spawnLivePid();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      writeLockFile(config, { pid: live.pid, command: "semantic-layer index --full" });

      const error = await withIndexLock(config, () => "unreachable").catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(IndexLockError);
      expect((error as IndexLockError).message).toContain(
        "another index run is already in progress",
      );
      expect((error as IndexLockError).message).toContain(`pid ${live.pid}`);
      expect((error as IndexLockError).message).toContain(indexLockFileForConfig(config));
      expect((error as IndexLockError).holder?.pid).toBe(live.pid);
      expect((error as IndexLockError).code).toBe("SEMANTIC_LAYER_INDEX_LOCKED");
      // A refused run must leave the live holder's lock untouched.
      expect(existsSync(indexLockFileForConfig(config))).toBe(true);
    } finally {
      live.kill();
      cleanup();
    }
  });

  it("fails fast when this process already holds the lock in another run", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      let finishFirst: () => void = () => undefined;
      const first = withIndexLock(
        config,
        () =>
          new Promise<void>((settle) => {
            finishFirst = () => settle();
          }),
      );

      const error = await withIndexLock(config, () => "unreachable").catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(IndexLockError);
      expect((error as IndexLockError).message).toContain("in this process");

      finishFirst();
      await first;
      expect(existsSync(indexLockFileForConfig(config))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reclaims a lock left by an earlier run whose pid this process now reuses", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      // Same pid, same host, but this process holds nothing: a reused pid must not wedge the vault.
      writeLockFile(config, { pid: process.pid });

      await expect(withIndexLock(config, () => "rebuilt")).resolves.toBe("rebuilt");
      expect(existsSync(indexLockFileForConfig(config))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reclaims a lock left behind by a dead process on this host", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      writeLockFile(config, { pid: await deadPid() });

      await expect(withIndexLock(config, () => "rebuilt")).resolves.toBe("rebuilt");
      expect(existsSync(indexLockFileForConfig(config))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reclaims a lock whose holder was never fully written", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      writeLockFile(config, "");

      await expect(withIndexLock(config, () => "rebuilt")).resolves.toBe("rebuilt");
    } finally {
      cleanup();
    }
  });

  it("reclaims a lock whose contents are not a holder record", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      writeLockFile(config, JSON.stringify(["not", "a", "holder"]));

      await expect(withIndexLock(config, () => "rebuilt")).resolves.toBe("rebuilt");

      writeLockFile(config, JSON.stringify({ hostname: hostname() }));
      await expect(withIndexLock(config, () => "rebuilt again")).resolves.toBe("rebuilt again");
    } finally {
      cleanup();
    }
  });

  it("never deletes a lock that belongs to someone else on release", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      const lockFile = indexLockFileForConfig(config);
      await withIndexLock(config, () => {
        // Simulates another process reclaiming this lock mid-run.
        writeLockFile(config, { pid: process.pid + 1 });
      });
      expect(existsSync(lockFile)).toBe(true);
      expect((JSON.parse(readFileSync(lockFile, "utf8")) as LockHolderFile).pid).toBe(
        process.pid + 1,
      );
    } finally {
      cleanup();
    }
  });

  it("keeps a lock from another host even when its pid is dead locally", async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const config = configFor(dir);
      await withIndexLock(config, () => undefined);
      writeLockFile(config, { pid: await deadPid(), hostname: "another-host" });

      const error = await withIndexLock(config, () => "unreachable").catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(IndexLockError);
      expect((error as IndexLockError).message).toContain("another-host");
      expect(existsSync(indexLockFileForConfig(config))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
