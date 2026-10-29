export const AGENTS = ["plan", "build", "review", "debug"] as const;
export type AgentName = (typeof AGENTS)[number];

export type Target = "issue" | "pull_request" | "pull_request_review_comment";

export type ParsedCommand =
  | { kind: "ignore" }
  | { kind: "run"; agent: AgentName; instruction: string; quote: string };

export type CommandCheck = { ok: true } | { ok: false; message: string };

const PREFIX = /^\/(?:oc|opencode)(?=\s|$)/;

function isAgentName(value: string): value is AgentName {
  return (AGENTS as readonly string[]).includes(value);
}

export function isPullRequestTarget(target: Target): boolean {
  return target !== "issue";
}

// GitHub's "Quote reply" puts the quoted text first, so the command may follow
// a leading block of "> " lines. The quote is what "this" refers to.
function splitQuote(body: string): { quote: string; text: string } {
  const lines = body.split("\n");
  const quoted: string[] = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*>/.test(line)) {
      quoted.push(line.replace(/^\s*> ?/, ""));
    } else if (line.trim() !== "") {
      break;
    }
  }
  return {
    quote: quoted.join("\n").trim(),
    text: lines.slice(index).join("\n").trimStart(),
  };
}

export function parseCommand(body: string, target: Target): ParsedCommand {
  const { quote, text } = splitQuote(body);
  const prefix = PREFIX.exec(text);
  if (!prefix) return { kind: "ignore" };

  const rest = text.slice(prefix[0].length).trim();
  const [first = "", ...others] = rest.split(/(\s+)/);
  const keyword = first.toLowerCase();

  if (isAgentName(keyword)) {
    return {
      kind: "run",
      agent: keyword,
      instruction: others.join("").trim(),
      quote,
    };
  }

  if (rest === "") {
    return {
      kind: "run",
      agent: isPullRequestTarget(target) ? "review" : "plan",
      instruction: "",
      quote,
    };
  }

  return { kind: "run", agent: "plan", instruction: rest, quote };
}

export function usage(target: Target): string {
  const lines = [
    "Usage: `/oc [plan|build|review|debug] <instruction>` (`/opencode` also works).",
    "",
    "- `plan` (default): investigate and propose a plan. Read-only.",
    "- `debug`: diagnose a bug or failure and find the root cause. Read-only.",
  ];
  if (isPullRequestTarget(target)) {
    lines.push(
      "- `review`: review this pull request with inline comments. Read-only.",
      "- `build`: make the change and commit it to this pull request.",
    );
  } else {
    lines.push(
      "- `build`: make the change on a new branch and open a pull request.",
    );
  }
  return lines.join("\n");
}

export function checkCommand(
  command: Extract<ParsedCommand, { kind: "run" }>,
  target: Target,
): CommandCheck {
  if (command.agent === "review" && !isPullRequestTarget(target)) {
    return {
      ok: false,
      message: `\`review\` only works on pull requests.\n\n${usage(target)}`,
    };
  }
  return { ok: true };
}
