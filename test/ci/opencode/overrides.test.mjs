import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { findAgentOverrides } from "../../../src/ci/opencode/overrides.mts";

function tree(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "overrides-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe("findAgentOverrides", () => {
  const ids = ["build", "ci-worker"];

  it("finds agent files of a CI agent's id, nested ones too", (t) => {
    const root = tree(t, {
      ".opencode/agents/build.md": "",
      ".opencode/agent/nested/ci-worker.md": "",
      ".opencode/agents/reviewer.md": "",
      ".opencode/agents/build.txt": "",
    });

    assert.deepEqual(findAgentOverrides(root, ids), [
      ".opencode/agent/nested/ci-worker.md defines the agent ci-worker",
      ".opencode/agents/build.md defines the agent build",
    ]);
  });

  it("finds a config file that configures a CI agent", (t) => {
    const root = tree(t, {
      "opencode.jsonc": '{ "agent": { "build": { "model": "x" } } }',
      ".opencode/opencode.json": '{ "agent": { "reviewer": {} } }',
    });

    assert.deepEqual(findAgentOverrides(root, ids), [
      "opencode.jsonc configures the agent build under agent",
    ]);
  });

  it("reads JSONC as OpenCode does, comments and escapes included", (t) => {
    const root = tree(t, {
      "opencode.jsonc": [
        "{",
        "  // the agents",
        '  "agents": {',
        '    "bu\\u0069ld": /* widened */ { "permission": {} },',
        "  },",
        '  "mode": { "ci-worker": {} },',
        '  "note": "\\"build\\": { is only text",',
        "}",
      ].join("\n"),
    });

    assert.deepEqual(findAgentOverrides(root, ids), [
      "opencode.jsonc configures the agent build under agents",
      "opencode.jsonc configures the agent ci-worker under mode",
    ]);
  });

  it("leaves other keys alone and fails closed on an unreadable file", (t) => {
    const root = tree(t, {
      "opencode.json": '{ "command": { "build": { "template": "x" } } }',
      ".opencode/opencode.jsonc": "{ not json",
    });

    assert.deepEqual(findAgentOverrides(root, ids), [
      ".opencode/opencode.jsonc cannot be read as JSON",
    ]);
  });

  it("finds nothing in a tree without OpenCode config", (t) => {
    assert.deepEqual(findAgentOverrides(tree(t, { "README.md": "" }), ids), []);
  });
});
