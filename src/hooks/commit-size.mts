// A pre-commit check that keeps commits small enough to review: the staged
// additions and deletions must stay within a limit, leaving out lockfiles,
// binary files and files marked `linguist-generated`.

import { UsageError } from "../errors.mts";
import { runCommand } from "../github/gh.mts";

export const DEFAULT_MAX_CHANGED_LINES = 500;
// Lockfiles that package managers write; nobody reviews them line by line.
export const DEFAULT_EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  "bun.lock",
  "Cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "uv.lock",
  "yarn.lock",
]);

function isExcluded(path: string, excludedPaths: ReadonlySet<string>): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return excludedPaths.has(path) || excludedPaths.has(name);
}

/** The lines `git diff --numstat` reports, without excluded and binary files. */
export function countChangedLines(
  numstat: string,
  excludedPaths: ReadonlySet<string> = DEFAULT_EXCLUDED_PATHS,
): number {
  let changedLines = 0;
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [additions, deletions, path] = line.split("\t");
    if (path === undefined) {
      throw new Error(`Unexpected git numstat line: ${line}`);
    }
    if (isExcluded(path, excludedPaths)) continue;
    if (additions === "-" && deletions === "-") continue;
    const additionCount = Number.parseInt(additions ?? "", 10);
    const deletionCount = Number.parseInt(deletions ?? "", 10);
    if (!Number.isInteger(additionCount) || !Number.isInteger(deletionCount)) {
      throw new Error(`Unexpected git numstat line: ${line}`);
    }
    changedLines += additionCount + deletionCount;
  }
  return changedLines;
}

export function numstatPaths(numstat: string): string[] {
  return numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[2])
    .filter((path): path is string => path !== undefined);
}

/**
 * Paths marked `linguist-generated`, from the NUL-separated output of
 * `git check-attr -z linguist-generated` (path, attribute, value triples).
 */
export function generatedPaths(checkAttrOutput: string): Set<string> {
  const fields = checkAttrOutput.split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index]!;
    const value = fields[index + 2];
    if (value === "set" || value === "true") generated.add(path);
  }
  return generated;
}

export function evaluateCommitSize(
  numstat: string,
  maxChangedLines: number = DEFAULT_MAX_CHANGED_LINES,
  excludedPaths: ReadonlySet<string> = DEFAULT_EXCLUDED_PATHS,
): { changedLines: number; maxChangedLines: number; passes: boolean } {
  const changedLines = countChangedLines(numstat, excludedPaths);
  return {
    changedLines,
    maxChangedLines,
    passes: changedLines <= maxChangedLines,
  };
}

export function parseMaxChangedLines(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHANGED_LINES;
  const maxChangedLines = Number(value);
  if (!Number.isInteger(maxChangedLines) || maxChangedLines < 1) {
    throw new UsageError("The limit must be a positive integer.");
  }
  return maxChangedLines;
}

export function parseArguments(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { maxChangedLines: number } {
  let max = env.MAX_COMMIT_CHANGED_LINES;
  const values = [...argv];
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--max") {
      max = values.shift();
      if (max === undefined) throw new UsageError("--max requires a number.");
    } else throw new UsageError(`Unknown argument: ${value}`);
  }
  return { maxChangedLines: parseMaxChangedLines(max) };
}

export function run(argv: string[]): void {
  const { maxChangedLines } = parseArguments(argv);
  const numstat = runCommand("git", [
    "diff",
    "--cached",
    "--numstat",
    "--no-renames",
  ]);
  const paths = numstatPaths(numstat);
  // --cached reads .gitattributes from the index, so the attributes being
  // committed decide, not uncommitted edits to them.
  const generated = paths.length
    ? generatedPaths(
        runCommand(
          "git",
          ["check-attr", "-z", "--cached", "--stdin", "linguist-generated"],
          { input: `${paths.join("\0")}\0` },
        ),
      )
    : new Set<string>();
  const result = evaluateCommitSize(
    numstat,
    maxChangedLines,
    new Set([...DEFAULT_EXCLUDED_PATHS, ...generated]),
  );
  if (result.passes) return;
  throw new Error(
    [
      `The commit has ${result.changedLines} reviewable changed lines; the limit is ${result.maxChangedLines}.`,
      "Split the staged changes into smaller, focused commits.",
      "Mark generated files `linguist-generated` in .gitattributes to leave them out of the count.",
    ].join("\n"),
  );
}
