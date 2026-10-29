import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeError,
  neutralizeMentions,
  parseRunOutput,
  redactSecrets,
} from "../../../src/ci/opencode/output.mts";

const text = (messageID, value) =>
  JSON.stringify({ type: "text", part: { messageID, text: value } });

describe("parseRunOutput", () => {
  it("returns the text of the last assistant message", () => {
    const jsonl = [
      JSON.stringify({ type: "step_start", part: {} }),
      text("m1", "Let me look at the files."),
      JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
      text("m2", "Final "),
      text("m2", "answer."),
      "not json",
      "",
    ].join("\n");
    assert.deepEqual(parseRunOutput(jsonl), { text: "Final answer." });
  });

  it("reports the error event", () => {
    const jsonl = JSON.stringify({
      type: "error",
      error: { type: "provider.no-route", message: "Model unavailable: a/b" },
    });
    assert.deepEqual(parseRunOutput(jsonl), {
      text: "",
      error: {
        type: "provider.no-route",
        status: undefined,
        message: "Model unavailable: a/b",
      },
    });
  });
});

describe("redactSecrets", () => {
  it("masks configured secret values", () => {
    const env = { OPENAI_API_KEY: "sk-1234567890", ANTHROPIC_API_KEY: "short" };
    assert.equal(
      redactSecrets("key sk-1234567890 and sk-1234567890; short stays", env),
      "key *** and ***; short stays",
    );
  });
});

describe("neutralizeMentions", () => {
  it("breaks user and team mentions outside code fences", () => {
    const text = [
      "Ping @alice and (@org/team).",
      "Mail me at bob@example.com, keep `@inline` code.",
      "```ts",
      "@Component() class A {}",
      "```",
      "@carol",
    ].join("\n");
    assert.equal(
      neutralizeMentions(text),
      [
        "Ping @\u200balice and (@\u200borg/team).",
        "Mail me at bob@example.com, keep `@inline` code.",
        "```ts",
        "@Component() class A {}",
        "```",
        "@\u200bcarol",
      ].join("\n"),
    );
  });
});

describe("describeError", () => {
  it("includes the type, status, and message", () => {
    assert.equal(
      describeError({ type: "provider.auth", status: 401, message: "bad key" }),
      "provider.auth (HTTP 401): bad key",
    );
  });
});
