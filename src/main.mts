import { UsageError } from "./errors.mts";
import { packageVersion } from "./package-root.mts";

export interface Command {
  /** One line for the command list. */
  summary: string;
  /** Loaded only when the command runs. */
  load: () => Promise<{ run: (argv: string[]) => void | Promise<void> }>;
}

/** Every command, by its words on the command line. */
export const commands: Record<string, Command> = {
  "ci opencode": {
    summary: "Run a step of the /oc agent workflow (used by the workflow)",
    load: () => import("./ci/opencode/main.mts"),
  },
  "setup github": {
    summary: "Apply repository settings, labels and main protection",
    load: () => import("./github/setup.mts"),
  },
  "setup secrets": {
    summary: "Set provider keys or another repository or environment secret",
    load: () => import("./github/secrets.mts"),
  },
};

export function usage(): string {
  const names = Object.keys(commands);
  const width = Math.max(0, ...names.map((name) => name.length));
  const lines = Object.entries(commands).map(
    ([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`,
  );
  return [
    "Usage: repo-kit <command> [options]",
    "",
    ...(lines.length > 0 ? ["Commands:", ...lines, ""] : []),
    "Options:",
    "  --help     Show this help",
    "  --version  Show the version",
  ].join("\n");
}

/** The command an argument list names, and the arguments left for it. */
export function resolveCommand(
  argv: string[],
): { name: string; command: Command; rest: string[] } | undefined {
  for (let words = Math.min(argv.length, 2); words > 0; words -= 1) {
    const name = argv.slice(0, words).join(" ");
    const command = commands[name];
    if (command) return { name, command, rest: argv.slice(words) };
  }
  return undefined;
}

/** Run the command line and return the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [first] = argv;
  if (first === undefined) {
    console.error(usage());
    return 2;
  }
  if (first === "--help" || first === "-h") {
    console.log(usage());
    return 0;
  }
  if (first === "--version") {
    console.log(packageVersion());
    return 0;
  }
  const resolved = resolveCommand(argv);
  if (!resolved) {
    console.error(`Unknown command: ${argv.slice(0, 2).join(" ")}\n`);
    console.error(usage());
    return 2;
  }
  try {
    const { run } = await resolved.command.load();
    await run(resolved.rest);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
