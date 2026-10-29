import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const AGENT_DIRECTORIES = ["agent", "agents", "mode", "modes"];
const CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
];
// The keys of a config file whose entries define agents: `agents` is the
// current one, `agent` and `mode` the earlier ones OpenCode still reads.
const AGENT_KEYS = ["agent", "agents", "mode"];

/**
 * JSONC as JSON: comments and trailing commas removed, strings kept as they
 * are, so the result parses with JSON.parse.
 */
export function stripJsonc(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') {
        end += source[end] === "\\" ? 2 : 1;
      }
      output += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Where the tree an agent runs in configures one of the CI agents. OpenCode
 * merges a project's agent over the one of the same id, with the project's
 * model and permission rules winning, so such a tree could widen what a CI
 * agent may do. A config file that cannot be read counts as configuring
 * them, since it cannot be shown not to.
 */
export function findAgentOverrides(
  root: string,
  ids: readonly string[],
): string[] {
  const found: string[] = [];
  for (const directory of AGENT_DIRECTORIES) {
    const full = path.join(root, ".opencode", directory);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { recursive: true })) {
      const file = String(entry);
      const id = path.basename(file).replace(/\.md$/, "");
      if (file.endsWith(".md") && ids.includes(id)) {
        found.push(`.opencode/${directory}/${file} defines the agent ${id}`);
      }
    }
  }
  for (const file of CONFIG_FILES) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    let config: unknown;
    try {
      config = JSON.parse(stripJsonc(readFileSync(full, "utf8")));
    } catch {
      found.push(`${file} cannot be read as JSON`);
      continue;
    }
    if (typeof config !== "object" || config === null) continue;
    for (const key of AGENT_KEYS) {
      const agents = (config as Record<string, unknown>)[key];
      if (typeof agents !== "object" || agents === null) continue;
      for (const id of Object.keys(agents)) {
        if (ids.includes(id)) {
          found.push(`${file} configures the agent ${id} under ${key}`);
        }
      }
    }
  }
  return found;
}
