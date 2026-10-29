import { extractJsonBlock } from "./output.mts";

export interface BuildSummary {
  title: string;
  commitMessage: string;
  summary: string;
}

const MAX_TITLE = 72;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? "";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export function parseBuildOutput(output: string): BuildSummary | undefined {
  const block = extractJsonBlock(output);
  if (block === undefined) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;

  const record = data as Record<string, unknown>;
  const title = firstLine(text(record.title));
  const commitMessage = text(record.commit);
  const summary = text(record.summary);
  if (!title || !firstLine(commitMessage) || !summary) return undefined;

  return { title: clip(title, MAX_TITLE), commitMessage, summary };
}

// Used when the agent made changes but did not end with a usable JSON block.
export function fallbackBuildSummary(
  output: string,
  instruction: string,
  number: number,
): BuildSummary {
  const subject = clip(
    firstLine(instruction) || `Apply /oc build for #${number}`,
    MAX_TITLE,
  );
  return {
    title: subject,
    commitMessage: `chore: ${subject}\n\nRequested in #${number}.`,
    summary: output.trim() || "The agent did not describe its changes.",
  };
}

// The attempt keeps a re-run from colliding with a branch an earlier attempt
// already pushed.
export function buildBranchName(
  number: number,
  runId: string,
  attempt: string,
): string {
  return `opencode/issue-${number}-${runId}-${attempt}`;
}

const CLOSING =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?\s+)((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;

// Closing keywords in a PR body close those issues on merge; only the issue
// the build was requested on should close, so others become code spans.
export function neutralizeClosingKeywords(text: string): string {
  return text.replace(CLOSING, "$1$2`$3`");
}

// GITHUB_TOKEN cannot push changes to workflow files.
export function workflowChanges(paths: string[]): string[] {
  return paths.filter((file) => file.startsWith(".github/workflows/"));
}

export function pullRequestBody(
  summary: string,
  number: number,
  foot: string,
): string {
  return `${neutralizeClosingKeywords(summary)}\n\nCloses #${number}\n\n${foot}`;
}
