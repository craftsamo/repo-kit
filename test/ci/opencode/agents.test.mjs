// Guards the security model of the CI agents in assets/opencode/agents/.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { AGENTS } from "../../../src/ci/opencode/command.mts";
import { parseDefaultModels } from "../../../src/ci/opencode/models.mts";
import { assetPath } from "../../../src/package-root.mts";

const configDir = assetPath("opencode");
const agentsDir = path.join(configDir, "agents");

// Rules are written one per line as YAML flow mappings.
function decode(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function parseAgent(file) {
  const text = readFileSync(path.join(agentsDir, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file}: missing frontmatter`);
  const [, frontmatter, body] = match;
  const rules = [];
  for (const line of frontmatter.split("\n")) {
    if (!/^\s*-\s*\{/.test(line)) continue;
    const fields = {};
    for (const [, key, value] of line.matchAll(
      /(\w+):\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}]+)/g,
    )) {
      fields[key] = decode(value);
    }
    assert.ok(
      fields.action && fields.resource && fields.effect,
      `${file}: unparsed rule ${line.trim()}`,
    );
    rules.push(fields);
  }
  const mode = /^mode:\s*(\S+)/m.exec(frontmatter)?.[1];
  return {
    file,
    name: file.replace(/\.md$/, ""),
    mode,
    frontmatter,
    body,
    rules,
  };
}

const agents = readdirSync(agentsDir)
  .filter((file) => file.endsWith(".md"))
  .map(parseAgent)
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const READ_ONLY_GIT = [
  "log",
  "show",
  "blame",
  "status",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "merge-base",
  "diff",
];
const PR_DIFF = ["git diff refs/opencode/*", "git diff * refs/opencode/*"];
const OWN_EDITS_DIFF = ["git diff", "git diff --stat", "git diff -- *"];
const GIT_GUARDS = [
  "git *--out*",
  "git *--no-index*",
  "git *--con*",
  "git *--ext-diff*",
  "git *--textconv*",
  "git * /*",
  "git *=/*",
  "git *../*",
  "git * ~*",
  'git *"*',
  "git *'*",
  "git *$*",
];
const EDIT_GUARDS = [
  ".github/workflows/*",
  "*.git",
  "*.git/*",
  "*.env",
  "*.env.*",
];
const NEVER_ALLOWED = [
  "*",
  "execute",
  "browser",
  "webfetch",
  "websearch",
  "external_directory",
];
// Subagents use their own permissions, not their parent's, so each parent may
// launch only these, and subagents launch none.
const SUBAGENT_CALLS = {
  plan: ["ci-explore"],
  build: ["ci-explore", "ci-reviewer", "ci-worker"],
  review: ["ci-explore", "ci-reviewer", "ci-reviewer-deep"],
  debug: ["ci-explore"],
};
const SUBAGENTS = [...new Set(Object.values(SUBAGENT_CALLS).flat())].sort();
// Uncommitted edits exist only in build's working tree.
const SEES_OWN_EDITS = ["build", "ci-reviewer", "ci-worker"];
// Only agents that run in build's separate clone may edit; the others run in
// the checkout whose scripts the publish step runs with the token.
const EDITORS = ["build", "ci-worker"];

const lastIndex = (rules, predicate) => rules.findLastIndex(predicate);
const firstIndex = (rules, predicate) => rules.findIndex(predicate);

describe("CI agents", () => {
  it("are the /oc agents and the CI subagents", () => {
    assert.deepEqual(
      agents.map((agent) => agent.name),
      [...AGENTS, ...SUBAGENTS].sort(),
    );
  });

  for (const agent of agents) {
    describe(agent.name, () => {
      const { rules } = agent;
      const shellAllows = rules.filter(
        (rule) => rule.action === "shell" && rule.effect === "allow",
      );

      // An empty body keeps OpenCode's built-in prompt; the CI instructions
      // come from instructions/<name>.md through plugins/instructions.ts.
      it("keeps the built-in prompt and the parent's model", () => {
        const primary = AGENTS.includes(agent.name);
        assert.equal(agent.mode, primary ? "primary" : "subagent");
        assert.equal(agent.body.trim(), "");
        assert.ok(!/^model:/m.test(agent.frontmatter), "pins a model");
      });

      it("launches only its CI subagents", () => {
        const launched = rules
          .filter(
            (rule) => rule.action === "subagent" && rule.effect === "allow",
          )
          .map((rule) => rule.resource)
          .sort();
        assert.deepEqual(launched, SUBAGENT_CALLS[agent.name] ?? []);
      });

      it("has CI instructions", () => {
        assert.ok(
          existsSync(path.join(configDir, "instructions", `${agent.name}.md`)),
        );
      });

      it("starts by sending everything to ask", () => {
        assert.deepEqual(rules[0], {
          action: "*",
          resource: "*",
          effect: "ask",
        });
      });

      // The free tier rejects requests whose core tools were trimmed by deny
      // rules; only Code Mode and the desktop browser are removed.
      it("denies Code Mode and the browser and nothing else", () => {
        const denied = rules.filter((rule) => rule.effect === "deny");
        assert.deepEqual(
          denied.map((rule) => [rule.action, rule.resource]).sort(),
          [
            ["browser", "*"],
            ["execute", "*"],
          ],
        );
      });

      it("never allows network or outside directories", () => {
        for (const rule of rules) {
          if (rule.effect !== "allow") continue;
          assert.ok(
            !NEVER_ALLOWED.includes(rule.action),
            `allows ${rule.action} ${rule.resource}`,
          );
        }
      });

      it("allows skills", () => {
        assert.ok(
          rules.some(
            (rule) =>
              rule.action === "skill" &&
              rule.resource === "*" &&
              rule.effect === "allow",
          ),
        );
      });

      it("only allows read-only git commands in the shell", () => {
        assert.ok(shellAllows.length > 0);
        for (const { resource } of shellAllows) {
          const subcommand = /^git ([\w-]+)/.exec(resource)?.[1];
          assert.ok(
            subcommand && READ_ONLY_GIT.includes(subcommand),
            `allows shell ${resource}`,
          );
          if (subcommand === "diff") {
            const forms = SEES_OWN_EDITS.includes(agent.name)
              ? [...PR_DIFF, ...OWN_EDITS_DIFF]
              : PR_DIFF;
            assert.ok(forms.includes(resource), `allows shell ${resource}`);
          }
        }
      });

      it("keeps every git guard after the last shell allow", () => {
        const lastAllow = lastIndex(
          rules,
          (rule) => rule.action === "shell" && rule.effect === "allow",
        );
        for (const guard of GIT_GUARDS) {
          const index = firstIndex(
            rules,
            (rule) =>
              rule.action === "shell" &&
              rule.resource === guard &&
              rule.effect === "ask",
          );
          assert.ok(index !== -1, `missing guard ${guard}`);
          assert.ok(index > lastAllow, `guard ${guard} precedes an allow`);
        }
      });

      it("uses no backslashes in patterns", () => {
        for (const rule of rules) {
          assert.ok(!rule.resource.includes("\\"), `pattern ${rule.resource}`);
        }
      });

      const edits = rules.filter((rule) => rule.action === "edit");
      if (EDITORS.includes(agent.name)) {
        it("edits files but keeps workflow, git, and env paths guarded", () => {
          const allow = lastIndex(
            edits,
            (rule) => rule.resource === "*" && rule.effect === "allow",
          );
          assert.ok(allow !== -1, "build cannot edit");
          for (const guard of EDIT_GUARDS) {
            const index = firstIndex(
              edits,
              (rule) => rule.resource === guard && rule.effect === "ask",
            );
            assert.ok(
              index > allow,
              `missing or misplaced edit guard ${guard}`,
            );
          }
        });
      } else {
        it("cannot edit files", () => {
          assert.ok(!edits.some((rule) => rule.effect === "allow"));
        });
      }
    });
  }
});

describe("CI instructions", () => {
  it("ship the shared instructions and the plugin that adds them", () => {
    assert.ok(existsSync(path.join(configDir, "instructions", "common.md")));
    assert.ok(existsSync(path.join(configDir, "plugins", "instructions.ts")));
  });

  it("only exist for CI agents", () => {
    const names = readdirSync(path.join(configDir, "instructions"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/, ""))
      .filter((name) => name !== "common")
      .sort();
    assert.deepEqual(
      names,
      agents.map((agent) => agent.name),
    );
  });
});

describe("default models", () => {
  it("parses the shipped models.json", () => {
    const models = parseDefaultModels(
      readFileSync(path.join(configDir, "models.json"), "utf8"),
    );
    assert.ok(models.candidates.length > 0);
    for (const model of models.candidates) {
      assert.ok(
        /^opencode\/\S+-free$/.test(model) ||
          /^openrouter\/\S+:free$/.test(model),
        `${model} is not a free model`,
      );
    }
  });

  // Free OpenRouter endpoints may log or train on prompts; only
  // zero-data-retention endpoints are acceptable.
  it("restricts OpenRouter to zero-data-retention endpoints", () => {
    const config = JSON.parse(
      readFileSync(path.join(configDir, "opencode.json"), "utf8"),
    );
    const openrouter = config.providers.openrouter;
    assert.deepEqual(openrouter.body.provider, {
      zdr: true,
      data_collection: "deny",
    });
    const models = parseDefaultModels(
      readFileSync(path.join(configDir, "models.json"), "utf8"),
    );
    for (const model of models.candidates) {
      if (!model.startsWith("openrouter/")) continue;
      const id = model.slice("openrouter/".length);
      assert.ok(id in openrouter.models, `${id} is not declared`);
      assert.ok(
        !("body" in openrouter.models[id]),
        `${id} overrides the provider body`,
      );
    }
  });
});
