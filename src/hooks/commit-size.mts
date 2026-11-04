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

export interface NumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly path: string;
}

function isExcluded(path: string, excludedPaths: ReadonlySet<string>): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return excludedPaths.has(path) || excludedPaths.has(name);
}

/**
 * Parses NUL-separated `git diff --numstat -z -M` output into entries.
 * For renamed or copied files, `path` is the new path.
 */
export function parseNumstat(numstat: string): NumstatEntry[] {
  if (!numstat) return [];
  const parts = numstat.split("\0");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  const entries: NumstatEntry[] = [];
  let index = 0;
  while (index < parts.length) {
    const chunk = parts[index]!;
    const firstTab = chunk.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : chunk.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`Unexpected git numstat entry: ${chunk}`);
    }
    const additionsRaw = chunk.slice(0, firstTab);
    const deletionsRaw = chunk.slice(firstTab + 1, secondTab);
    const pathPart = chunk.slice(secondTab + 1);

    let additions: number;
    let deletions: number;
    if (additionsRaw === "-" && deletionsRaw === "-") {
      additions = 0;
      deletions = 0;
    } else if (/^\d+$/.test(additionsRaw) && /^\d+$/.test(deletionsRaw)) {
      additions = Number.parseInt(additionsRaw, 10);
      deletions = Number.parseInt(deletionsRaw, 10);
    } else {
      throw new Error(`Unexpected git numstat entry: ${chunk}`);
    }

    let path: string;
    if (pathPart === "") {
      if (index + 2 >= parts.length) {
        throw new Error("Unexpected git numstat entry: incomplete rename");
      }
      path = parts[index + 2]!;
      index += 3;
    } else {
      path = pathPart;
      index += 1;
    }

    entries.push({ additions, deletions, path });
  }
  return entries;
}

function toEntries(
  numstat: string | readonly NumstatEntry[],
): readonly NumstatEntry[] {
  return typeof numstat === "string" ? parseNumstat(numstat) : numstat;
}

/** The lines `git diff --numstat` reports, without excluded and binary files. */
export function countChangedLines(
  numstat: string | readonly NumstatEntry[],
  excludedPaths: ReadonlySet<string> = DEFAULT_EXCLUDED_PATHS,
): number {
  let changedLines = 0;
  for (const entry of toEntries(numstat)) {
    if (isExcluded(entry.path, excludedPaths)) continue;
    changedLines += entry.additions + entry.deletions;
  }
  return changedLines;
}

export function numstatPaths(
  numstat: string | readonly NumstatEntry[],
): string[] {
  return toEntries(numstat).map((entry) => entry.path);
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
  numstat: string | readonly NumstatEntry[],
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
    "-z",
    "-M",
  ]);
  const entries = parseNumstat(numstat);
  const paths = numstatPaths(entries);
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
    entries,
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
