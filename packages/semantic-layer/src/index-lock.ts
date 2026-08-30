import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { ResolvedConfig } from "./types.js";

/** Serialized owner of an index lock file; `command` is diagnostic only. */
export type IndexLockHolder = {
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
};

/** Thrown when another index run already owns the vault's index lock. */
export class IndexLockError extends Error {
  readonly code = "SEMANTIC_LAYER_INDEX_LOCKED";
  readonly lockFile: string;
  readonly holder: IndexLockHolder | undefined;

  constructor(lockFile: string, holder: IndexLockHolder | undefined, inProcess = false) {
    super(describeConflict(lockFile, holder, inProcess));
    this.name = "IndexLockError";
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

/** The lock sits beside the SQLite index so search-disabled vaults lock the same way. */
export function indexLockFileForConfig(config: ResolvedConfig): string {
  return resolve(config.vaultDir, ".semantic-layer", "index.lock");
}

type LockState = {
  held: Set<string>;
  exitHookInstalled: boolean;
};

const STATE_KEY = Symbol.for("@madebywild/semantic-layer/index-lock");

function getState(): LockState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: LockState };
  holder[STATE_KEY] ??= { held: new Set(), exitHookInstalled: false };
  return holder[STATE_KEY];
}

const activeLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Runs `fn` while holding the vault's exclusive cross-process index lock.
 *
 * Acquisition never waits: a second concurrent index run fails immediately with an
 * `IndexLockError` instead of interleaving writes into the generated files or racing the
 * SQLite build. Because nothing ever blocks on the lock, no wait cycle can form with
 * SQLite's own busy timeout, whatever order the two are taken in. Nested calls for the same
 * vault reuse the held lock, so an index command that also builds the database and recovers
 * a corrupt one acquires only once.
 */
export async function withIndexLock<T>(
  config: ResolvedConfig,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockFile = indexLockFileForConfig(config);
  const inherited = activeLocks.getStore();
  if (inherited?.has(lockFile)) return fn();

  acquire(lockFile);
  const owned = new Set(inherited ?? []).add(lockFile);
  try {
    return await activeLocks.run(owned, fn);
  } finally {
    release(lockFile);
  }
}

function acquire(lockFile: string): void {
  const state = getState();
  // Checked before the file: this process knows authoritatively which locks it owns, which is
  // what makes a lock file naming our own pid safe to reclaim below.
  if (state.held.has(lockFile)) throw new IndexLockError(lockFile, readHolder(lockFile), true);

  mkdirSync(dirname(lockFile), { recursive: true });
  if (tryCreate(lockFile)) return;

  const observed = statSync(lockFile, { throwIfNoEntry: false });
  const holder = observed ? readHolder(lockFile) : undefined;
  if (observed && isHolderAlive(holder)) throw new IndexLockError(lockFile, holder);

  // Nobody owns this lock any more, so it is reclaimable derived state like the index itself.
  if (observed) reclaimStale(lockFile, observed);
  if (tryCreate(lockFile)) return;
  throw new IndexLockError(lockFile, readHolder(lockFile));
}

function tryCreate(lockFile: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockFile, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(currentHolder())}\n`);
  } finally {
    closeSync(fd);
  }
  const state = getState();
  state.held.add(lockFile);
  installExitHook();

  // Two processes can decide the same lock is stale at once, and the loser would otherwise
  // delete the winner's fresh lock and create its own. Reading back what is actually on disk
  // settles that: only the process whose holder survived owns the lock.
  const stored = readHolder(lockFile);
  if (stored && stored.pid !== process.pid) {
    state.held.delete(lockFile);
    throw new IndexLockError(lockFile, stored);
  }
  return true;
}

function release(lockFile: string): void {
  const state = getState();
  state.held.delete(lockFile);
  // Only remove a lock this process still owns: a stale reclaim may have handed it on.
  const holder = readHolder(lockFile);
  if (holder && holder.pid !== process.pid) return;
  removeQuietly(lockFile);
}

/** Removes the exact file judged stale, never a fresh lock another process created since. */
function reclaimStale(lockFile: string, observed: Stats): void {
  const current = statSync(lockFile, { throwIfNoEntry: false });
  if (!current) return;
  if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) return;
  removeQuietly(lockFile);
}

function removeQuietly(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function currentHolder(): IndexLockHolder {
  return {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(" ").trim(),
  };
}

function readHolder(lockFile: string): IndexLockHolder | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const candidate = parsed as Partial<IndexLockHolder> | null;
  if (!candidate || typeof candidate !== "object") return undefined;
  if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid)) return undefined;
  if (typeof candidate.hostname !== "string") return undefined;
  return {
    pid: candidate.pid,
    hostname: candidate.hostname,
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "unknown",
    command: typeof candidate.command === "string" ? candidate.command : "",
  };
}

function isHolderAlive(holder: IndexLockHolder | undefined): boolean {
  // A missing or unreadable holder means a writer died between creating and describing its
  // lock, or wrote something that is not a lock at all. Either way nobody owns it.
  if (!holder) return false;
  // Pids are only comparable on the machine that recorded them, so a lock from another host
  // (or another container's pid namespace) is assumed live and has to be removed deliberately.
  if (holder.hostname !== hostname()) return true;
  // Our own pid without a matching entry in `held` is a leftover from an earlier run whose pid
  // this process reuses; blocking on it would wedge the vault permanently.
  if (holder.pid === process.pid) return false;
  try {
    process.kill(holder.pid, 0);
    // `kill(pid, 0)` succeeds for a Linux zombie even though it can no longer own a lock.
    // Treat it as stale so a killed index run cannot wedge a vault while its parent has not
    // reaped it yet (notably in minimal container PID namespaces).
    return !isZombieProcess(holder.pid);
  } catch (error) {
    // EPERM means the pid exists but belongs to another user, so the lock is still live.
    return errorCode(error) === "EPERM";
  }
}

function isZombieProcess(pid: number): boolean {
  // `/proc` is Linux-specific; other platforms retain the portable `kill(pid, 0)` behavior.
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesized and can itself contain spaces or parentheses. The state
    // immediately follows its final closing parenthesis.
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd >= 0 && stat[commandEnd + 2] === "Z";
  } catch {
    // The process disappeared while checking it. The next acquisition attempt will observe the
    // missing pid through `kill(pid, 0)` or atomically settle the lock file race.
    return false;
  }
}

function installExitHook(): void {
  const state = getState();
  if (state.exitHookInstalled) return;
  state.exitHookInstalled = true;
  process.once("exit", releaseHeldLocksNow);
}

function releaseHeldLocksNow(): void {
  const state = getState();
  for (const lockFile of [...state.held]) {
    try {
      release(lockFile);
    } catch {
      // Best effort at shutdown; a leftover lock is reclaimed as stale by the next run.
    }
  }
  state.held.clear();
}

function describeConflict(
  lockFile: string,
  holder: IndexLockHolder | undefined,
  inProcess: boolean,
): string {
  const who = holder
    ? `pid ${holder.pid} on host ${holder.hostname}, started ${holder.startedAt}` +
      (holder.command ? `, \`${holder.command}\`` : "")
    : "an unidentified process";
  const conflict = inProcess
    ? `another index run is already in progress in this process (${who})`
    : `another index run is already in progress for this vault (${who})`;
  const remedy = inProcess
    ? "Await the first run before starting another."
    : `Wait for it to finish, or remove ${lockFile} if that process is gone.`;
  return `semantic-layer index: ${conflict}. ${remedy}`;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
