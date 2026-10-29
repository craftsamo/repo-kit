import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkCommand,
  parseCommand,
  usage,
} from "../../../src/ci/opencode/command.mts";

describe("parseCommand", () => {
  it("ignores comments that do not start with the command prefix", () => {
    assert.deepEqual(parseCommand("please /oc review", "pull_request"), {
      kind: "ignore",
    });
    assert.deepEqual(parseCommand("/octopus review", "pull_request"), {
      kind: "ignore",
    });
  });

  it("accepts both prefixes and leading whitespace", () => {
    assert.deepEqual(parseCommand("  /opencode debug why?", "issue"), {
      kind: "run",
      agent: "debug",
      instruction: "why?",
      quote: "",
    });
    assert.deepEqual(parseCommand("/oc debug why?", "issue"), {
      kind: "run",
      agent: "debug",
      instruction: "why?",
      quote: "",
    });
  });

  it("reads the agent keyword case-insensitively and keeps multi-line text", () => {
    assert.deepEqual(
      parseCommand("/oc Review focus on\nsecurity", "pull_request"),
      {
        kind: "run",
        agent: "review",
        instruction: "focus on\nsecurity",
        quote: "",
      },
    );
  });

  it("treats text without an agent keyword as a plan request", () => {
    assert.deepEqual(parseCommand("/oc fix the login bug", "pull_request"), {
      kind: "run",
      agent: "plan",
      instruction: "fix the login bug",
      quote: "",
    });
  });

  it("reads a command that follows a quote reply and keeps the quote", () => {
    assert.deepEqual(
      parseCommand(
        "> **Bug**: off by one\n>\n> ```js\n> i <= n\n> ```\n\n/oc build これを修正してください",
        "pull_request",
      ),
      {
        kind: "run",
        agent: "build",
        instruction: "これを修正してください",
        quote: "**Bug**: off by one\n\n```js\ni <= n\n```",
      },
    );
  });

  it("ignores quotes that are not followed by a command", () => {
    assert.deepEqual(parseCommand("> /oc build\n\nnot now", "issue"), {
      kind: "ignore",
    });
  });

  it("defaults an empty command to review on pull requests and plan on issues", () => {
    assert.equal(parseCommand("/oc", "pull_request").agent, "review");
    assert.equal(
      parseCommand("/oc  ", "pull_request_review_comment").agent,
      "review",
    );
    assert.equal(parseCommand("/opencode", "issue").agent, "plan");
  });

  it("reads build as an agent keyword", () => {
    assert.deepEqual(parseCommand("/oc build add tests", "issue"), {
      kind: "run",
      agent: "build",
      instruction: "add tests",
      quote: "",
    });
  });
});

describe("checkCommand", () => {
  it("accepts plan, debug, and build in every context", () => {
    for (const target of [
      "issue",
      "pull_request",
      "pull_request_review_comment",
    ]) {
      for (const agent of ["plan", "debug", "build"]) {
        assert.deepEqual(
          checkCommand({ kind: "run", agent, instruction: "" }, target),
          { ok: true },
        );
      }
    }
  });

  it("rejects review outside pull requests", () => {
    const result = checkCommand(
      { kind: "run", agent: "review", instruction: "" },
      "issue",
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /only works on pull requests/);
  });
});

describe("usage", () => {
  it("only lists review on pull requests", () => {
    assert.doesNotMatch(usage("issue"), /`review`/);
    assert.match(usage("pull_request"), /`review`/);
  });

  it("describes where build commits", () => {
    assert.match(usage("issue"), /`build`: .*new branch.*pull request/);
    assert.match(usage("pull_request"), /`build`: .*this pull request/);
  });
});
