// Adds the CI instructions to each CI agent's system prompt. The agent files
// leave their prompt body empty, so OpenCode keeps its built-in prompts (and
// their per-model variants) and these instructions come after them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

const directory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "instructions",
);

function loadInstructions(): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(directory)) return result;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(path.join(directory, file), "utf8").trim();
    result.set(file.slice(0, -".md".length), text);
  }
  return result;
}

export default Plugin.define({
  id: "ci.instructions",
  async setup(ctx) {
    const instructions = loadInstructions();
    const common = instructions.get("common");
    await ctx.session.hook("context", (event) => {
      // Only CI agents have instructions; OpenCode's internal agents, such as
      // the title generator, are left alone.
      const own = instructions.get(event.agent);
      if (!own || event.agent === "common") return;
      if (common) event.system.push({ type: "text", text: common });
      event.system.push({ type: "text", text: own });
    });
  },
});
