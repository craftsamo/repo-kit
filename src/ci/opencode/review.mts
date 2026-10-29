import { extractJsonBlock } from "./output.mts";

export interface ReviewFinding {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

export interface ParsedReview {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

// Git wraps unusual paths in quotes with C-style escapes, writing non-ASCII
// bytes as octal (`"caf\303\251.ts"`).
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = body.charAt(index + 1);
    bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// Lines GitHub accepts a RIGHT-side review comment on: added and context
// lines inside each hunk, keyed by the new path.
export function commentableLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let inHeader = false;
  let line = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = undefined;
      inHeader = true;
      line = 0;
      continue;
    }
    // Only the file header names the path; inside a hunk, "+++ x" is an
    // added line whose content starts with "++".
    if (inHeader && raw.startsWith("+++ ")) {
      const target = unquoteGitPath(raw.slice(4).trim());
      if (target === "/dev/null") {
        current = undefined;
      } else {
        const path = target.replace(/^b\//, "");
        current = result.get(path) ?? new Set<number>();
        result.set(path, current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (!current || line === 0) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      current.add(line);
      line += 1;
    }
  }
  return result;
}

function toFinding(value: unknown): ReviewFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const line = Number(item.line);
  if (typeof item.path !== "string" || typeof item.body !== "string") {
    return undefined;
  }
  if (!Number.isInteger(line) || line < 1) return undefined;

  const finding: ReviewFinding = { path: item.path, line, body: item.body };
  const startLine = Number(item.start_line ?? item.startLine);
  if (Number.isInteger(startLine) && startLine >= 1 && startLine < line) {
    finding.startLine = startLine;
  }
  return finding;
}

export function parseReviewOutput(text: string): ParsedReview | undefined {
  const block = extractJsonBlock(text);
  if (block === undefined) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;

  const record = data as Record<string, unknown>;
  const rawFindings = Array.isArray(record.comments) ? record.comments : [];
  return {
    summary: typeof record.summary === "string" ? record.summary.trim() : "",
    findings: rawFindings.map(toFinding).filter((item) => item !== undefined),
  };
}

export interface BuildReviewOptions {
  commitId: string;
  permalinkBase: string;
  footer: string;
}

function isCommentable(
  lines: Map<string, Set<number>>,
  path: string,
  line: number,
): boolean {
  return lines.get(path)?.has(line) ?? false;
}

function isRangeCommentable(
  lines: Map<string, Set<number>>,
  path: string,
  start: number,
  end: number,
): boolean {
  for (let line = start; line <= end; line += 1) {
    if (!isCommentable(lines, path, line)) return false;
  }
  return true;
}

function permalink(base: string, finding: ReviewFinding): string {
  const path = finding.path.split("/").map(encodeURIComponent).join("/");
  const anchor = finding.startLine
    ? `L${finding.startLine}-L${finding.line}`
    : `L${finding.line}`;
  return `${base}/${path}#${anchor}`;
}

// One block per finding: bodies may span several lines or hold code fences,
// which would break out of a list item.
function formatOutside(finding: ReviewFinding, base: string): string {
  const label = `\`${finding.path}:${finding.line}\``;
  return `**[${label}](${permalink(base, finding)})**\n\n${finding.body}`;
}

export function buildReviewPayload(
  review: ParsedReview,
  lines: Map<string, Set<number>>,
  options: BuildReviewOptions,
): ReviewPayload {
  const comments: ReviewComment[] = [];
  const outside: string[] = [];

  for (const finding of review.findings) {
    if (!isCommentable(lines, finding.path, finding.line)) {
      outside.push(formatOutside(finding, options.permalinkBase));
      continue;
    }
    const comment: ReviewComment = {
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: finding.body,
    };
    // GitHub rejects the whole review when a range spans hunks, and lines
    // between two hunks are outside the diff.
    if (
      finding.startLine &&
      isRangeCommentable(lines, finding.path, finding.startLine, finding.line)
    ) {
      comment.start_line = finding.startLine;
      comment.start_side = "RIGHT";
    }
    comments.push(comment);
  }

  const sections = [review.summary || "No issues found."];
  if (outside.length > 0) {
    sections.push("**Findings outside the diff**", ...outside);
  }
  sections.push(options.footer);

  return {
    commit_id: options.commitId,
    event: "COMMENT",
    body: sections.join("\n\n"),
    comments,
  };
}
