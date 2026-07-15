import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

/** `git rev-parse HEAD`, or `undefined` if `repoRoot` isn't a git repo (or has no commits yet). */
export function getHeadSha(repoRoot: string): string | undefined {
  return runGit(repoRoot, ["rev-parse", "HEAD"])?.trim();
}

/** Whether `sha` is an ancestor of (or equal to) HEAD. False on any git error (e.g. unknown SHA, shallow clone). */
export function isAncestorOfHead(repoRoot: string, sha: string): boolean {
  return runGit(repoRoot, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined;
}

/**
 * Vault-relative paths that may have changed since `sha`: a prefilter, not a verdict. Unions three
 * sources so uncommitted work is never missed — committed changes since `sha`, staged/unstaged
 * changes to tracked files, and untracked new files — and returns both sides of a rename, since
 * either side may need re-chunking. Deliberately doesn't classify added/modified/deleted itself:
 * the caller checks the live vault to decide whether a candidate note still exists.
 */
export function diffVaultFilesSinceSha(repoRoot: string, vaultDir: string, sha: string): string[] {
  const candidates = new Set<string>();
  const addPathsFromNameStatus = (output: string | undefined) => {
    if (!output) return;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [, ...paths] = line.split("\t");
      for (const path of paths) addCandidate(candidates, repoRoot, vaultDir, path);
    }
  };

  // `--relative` matters whenever `repoRoot` (the `cwd` git runs in, below) is itself a
  // subdirectory of the actual git top-level — e.g. any monorepo package. Without it, `git diff`
  // prints paths relative to the repo's true top-level, not to `repoRoot`, which silently broke
  // `toVaultRelativePath`'s resolution below and made every candidate in the subdirectory vanish.
  // `git ls-files` already defaults to cwd-relative output, so it doesn't need the flag.
  addPathsFromNameStatus(
    runGit(repoRoot, ["diff", "--relative", "--name-status", `${sha}..HEAD`, "--", vaultDir]),
  );
  addPathsFromNameStatus(
    runGit(repoRoot, ["diff", "--relative", "--name-status", "HEAD", "--", vaultDir]),
  );

  const untracked = runGit(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    vaultDir,
  ]);
  if (untracked) {
    for (const line of untracked.split("\n")) {
      if (line.trim()) addCandidate(candidates, repoRoot, vaultDir, line);
    }
  }

  return [...candidates].sort();
}

/**
 * `diffVaultFilesSinceSha`'s candidates, narrowed to actual note ids: non-`.md` paths (schema
 * files, the generated `code-refs.json`, or the search index's own artifacts if a consuming repo
 * hasn't picked up the recommended `.gitignore` entries yet) never correspond to a note and must
 * not spuriously count as a change.
 */
export function candidateNoteIdsSinceSha(
  repoRoot: string,
  vaultDir: string,
  sha: string,
): string[] {
  return diffVaultFilesSinceSha(repoRoot, vaultDir, sha)
    .filter((path) => path.endsWith(".md") && path !== "HIERARCHY.md")
    .map((path) => path.slice(0, -3));
}

function addCandidate(candidates: Set<string>, repoRoot: string, vaultDir: string, path: string) {
  const vaultPath = toVaultRelativePath(repoRoot, vaultDir, path);
  if (vaultPath) candidates.add(vaultPath);
}

function toVaultRelativePath(
  repoRoot: string,
  vaultDir: string,
  gitRelativePath: string,
): string | undefined {
  const relativeToVault = relative(vaultDir, resolve(repoRoot, gitRelativePath));
  if (relativeToVault === ".." || relativeToVault.startsWith(`..${sep}`)) return undefined;
  return relativeToVault.split(sep).join("/");
}

function runGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
