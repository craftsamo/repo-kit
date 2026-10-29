import type { AgentName } from "./command.mts";
import { shouldTryNextModel, type ModelSource } from "./models.mts";
import { describeError, type RunOutcome } from "./output.mts";

export const RUN_MESSAGE = "Handle the GitHub request in the input below.";

// Read-only agents rely on `ask` rules being rejected in non-interactive runs,
// so this must never pass --auto, --yolo, or --dangerously-skip-permissions.
export function buildRunArgs(agent: AgentName, model: string): string[] {
  return [
    "run",
    "--standalone",
    "--agent",
    agent,
    "--model",
    model,
    "--format",
    "json",
    RUN_MESSAGE,
  ];
}

export type Runner = (model: string) => RunOutcome;

export interface RunResult {
  ok: boolean;
  model?: string;
  text: string;
  error?: string;
  tried: string[];
}

export function runWithFallback(source: ModelSource, run: Runner): RunResult {
  const tried: string[] = [];
  let last: RunOutcome | undefined;

  for (const model of source.models) {
    tried.push(model);
    const outcome = run(model);
    last = outcome;

    if (!outcome.error) {
      if (outcome.text) return { ok: true, model, text: outcome.text, tried };
      return {
        ok: false,
        model,
        text: "",
        error: "The agent finished without an answer.",
        tried,
      };
    }
    if (!shouldTryNextModel(source.origin, outcome.error)) {
      return {
        ok: false,
        model,
        text: outcome.text,
        error: describeError(outcome.error),
        tried,
      };
    }
  }

  const reason = last?.error ? ` Last error: ${describeError(last.error)}` : "";
  return {
    ok: false,
    text: "",
    error: `No model could run this request (tried ${tried.join(", ")}).${reason}`,
    tried,
  };
}

export function footer(
  agent: AgentName,
  model: string | undefined,
  runUrl: string,
): string {
  const parts = ["OpenCode", `\`${agent}\``];
  if (model) parts.push(`\`${model}\``);
  parts.push(`[workflow run](${runUrl})`);
  return `<sub>${parts.join(" · ")}</sub>`;
}
