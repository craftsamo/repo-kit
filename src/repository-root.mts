import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Return the root of the repository a script works on: `REPOSITORY_ROOT` when
 * it is set, else the top of the git worktree holding `cwd`, else `cwd`.
 *
 * The root comes from where a script runs, not from where its file sits, so
 * the same script can work on a repository it is not part of.
 */
export function resolveRepositoryRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (env.REPOSITORY_ROOT) return path.resolve(cwd, env.REPOSITORY_ROOT);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

let resolved: string | undefined;

/** The repository the current command works on, resolved once. */
export function repositoryRoot(): string {
  resolved ??= resolveRepositoryRoot();
  return resolved;
}
