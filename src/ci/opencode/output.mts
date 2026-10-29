import type { RunError } from "./models.mts";

export interface RunOutcome {
  text: string;
  error?: RunError;
}

interface TextEvent {
  type: "text";
  part: { messageID?: string; text?: string };
}

interface ErrorEvent {
  type: "error";
  error?: { type?: string; status?: number; message?: string };
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isTextEvent(event: unknown): event is TextEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "text" &&
    typeof (event as { part?: unknown }).part === "object"
  );
}

function isErrorEvent(event: unknown): event is ErrorEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "error"
  );
}

// The answer is the text of the last assistant message; earlier messages are
// progress notes written between tool calls.
export function parseRunOutput(jsonl: string): RunOutcome {
  const texts: { messageID: string; text: string }[] = [];
  let error: RunError | undefined;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    if (isTextEvent(event) && event.part.text) {
      texts.push({
        messageID: event.part.messageID ?? "",
        text: event.part.text,
      });
    } else if (isErrorEvent(event)) {
      error = {
        type: event.error?.type,
        status: event.error?.status,
        message: event.error?.message,
      };
    }
  }

  const lastMessage = texts.at(-1)?.messageID;
  const text = texts
    .filter((item) => item.messageID === lastMessage)
    .map((item) => item.text)
    .join("")
    .trim();

  return error ? { text, error } : { text };
}

// Agents that return structured results end with a fenced json block. JSON
// strings cannot hold raw newlines, so a line holding only ``` always closes
// the block, even when a string inside quotes a ```suggestion fence.
export function extractJsonBlock(text: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => /^\s*```json\b/.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && /^\s*```\s*$/.test(line),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

export const SECRET_VARIABLES = [
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export function redactSecrets(
  text: string,
  env: Record<string, string | undefined>,
  names: readonly string[] = SECRET_VARIABLES,
): string {
  let result = text;
  for (const name of names) {
    const value = env[name];
    if (value && value.length >= 8) result = result.split(value).join("***");
  }
  return result;
}

const MENTION =
  /(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[\w.-]+)?)/g;

// Agent text can be steered by untrusted issue content, so it must not ping
// people or teams. A zero-width space after "@" breaks the mention; code
// fences are left alone so suggestions stay copyable.
export function neutralizeMentions(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(MENTION, "$1@\u200b$2");
    })
    .join("\n");
}

export function describeError(error: RunError): string {
  const status = error.status ? ` (HTTP ${error.status})` : "";
  return `${error.type ?? "error"}${status}: ${error.message ?? "unknown error"}`;
}
