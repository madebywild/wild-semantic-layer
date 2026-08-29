import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../../../../packages/semantic-layer/src/commands/index.js";
import { loadConfig } from "../../../../packages/semantic-layer/src/config.js";
import { recoverCorruptIndex } from "../../../../packages/semantic-layer/src/db/connection.js";
import { querySearch } from "../../../../packages/semantic-layer/src/db/queries/search.js";
import {
  IndexLockError,
  indexLockFileForConfig,
} from "../../../../packages/semantic-layer/src/index-lock.js";
import type { ResolvedConfig } from "../../../../packages/semantic-layer/src/types.js";
import { createFakeEmbedder, createTempVault, type TempVault } from "../../../helpers.js";

function validNoteMd(id: string, body = ""): string {
  return `---\nid: ${id}\ntitle: ${id}\ndesc: Test note.\nstatus: active\nowner: tester@example.com\nlast_verified: 2026-05-13\nttl_days: 365\n---\n\n${body}`;
}

function vaultWithNotes(config?: Record<string, unknown>): TempVault {
  return createTempVault(
    {
      "vault/root.md": validNoteMd("root", "# Root\n\nRuntime contract for the vault.\n"),
      "vault/alpha.md": validNoteMd("alpha", "# Alpha\n\nAlpha covers the runtime contract.\n"),
      "vault/root.schema.yml":
        "version: 1\nschemas:\n  - id: root\n    parent: root\n    children: [alpha]\n",
    },
    config,
  );
}

/** A process that stays alive until killed, so a planted lock names a genuinely live holder. */
function spawnLiveHolder(): { pid: number; kill: () => void; exited: Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("failed to spawn a live holder process");
  const exited = new Promise<void>((settle) => child.once("exit", () => settle()));
  return { pid: child.pid, kill: () => child.kill("SIGKILL"), exited };
}

function plantLock(config: ResolvedConfig, pid: number): string {
  const lockFile = indexLockFileForConfig(config);
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      command: "semantic-layer index",
    }),
  );
  return lockFile;
}

describe("index lock across commands", () => {
  it("leaves no lock behind after a successful index", async () => {
    const tv = vaultWithNotes();
    try {
      await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      expect(existsSync(indexLockFileForConfig(loadConfig({ cwd: tv.dir })))).toBe(false);
    } finally {
      tv.cleanup();
    }
  });

  it("refuses a second index run and leaves the generated files untouched", async () => {
    const tv = vaultWithNotes();
    const live = spawnLiveHolder();
    try {
      const first = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      const before = readFileSync(first.outFile, "utf8");
      writeFileSync(`${tv.vaultDir}/beta.md`, validNoteMd("beta"));

      const config = loadConfig({ cwd: tv.dir });
      const lockFile = plantLock(config, live.pid);
      const error = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(IndexLockError);
      expect((error as IndexLockError).message).toContain(`pid ${live.pid}`);
      expect(readFileSync(first.outFile, "utf8")).toBe(before);
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      live.kill();
      tv.cleanup();
    }
  });

  it("locks the database-free path too", async () => {
    const tv = vaultWithNotes({ search: { enabled: false } });
    const live = spawnLiveHolder();
    try {
      plantLock(loadConfig({ cwd: tv.dir }), live.pid);
      await expect(runIndex({ cwd: tv.dir })).rejects.toBeInstanceOf(IndexLockError);
      expect(existsSync(`${tv.vaultDir}/HIERARCHY.md`)).toBe(false);
    } finally {
      live.kill();
      tv.cleanup();
    }
  });

  it("reclaims a lock left behind by a killed run", async () => {
    const tv = vaultWithNotes();
    const dead = spawnLiveHolder();
    try {
      dead.kill();
      // Plant the lock only once the pid has actually left the process table.
      await dead.exited;
      const lockFile = plantLock(loadConfig({ cwd: tv.dir }), dead.pid);

      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      expect(result.noteCount).toBe(2);
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      tv.cleanup();
    }
  });

  it("refuses a search that would build an index, but still answers from an existing one", async () => {
    const tv = vaultWithNotes();
    const live = spawnLiveHolder();
    try {
      const config = loadConfig({ cwd: tv.dir });
      await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      plantLock(config, live.pid);

      await expect(
        querySearch(
          config,
          { query: "runtime contract", mode: "fts", rebuild: true },
          { embedder: createFakeEmbedder() },
        ),
      ).rejects.toBeInstanceOf(IndexLockError);

      // Reading is deliberately not locked: agents can keep searching during an index run.
      const hits = await querySearch(
        config,
        { query: "runtime contract", mode: "fts" },
        { embedder: createFakeEmbedder() },
      );
      expect(hits.hits.length).toBeGreaterThan(0);
    } finally {
      live.kill();
      tv.cleanup();
    }
  });

  it("refuses corruption recovery while another run holds the lock", async () => {
    const tv = vaultWithNotes();
    const live = spawnLiveHolder();
    try {
      const config = loadConfig({ cwd: tv.dir });
      const result = await runIndex({ cwd: tv.dir, embedder: createFakeEmbedder() });
      plantLock(config, live.pid);

      await expect(recoverCorruptIndex(config)).rejects.toBeInstanceOf(IndexLockError);
      expect(existsSync(result.db?.indexPath ?? "")).toBe(true);
    } finally {
      live.kill();
      tv.cleanup();
    }
  });
});
