import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRunArgs,
  footer,
  RUN_MESSAGE,
  runWithFallback,
} from "../../../src/ci/opencode/runner.mts";

const noRoute = { type: "provider.no-route", message: "Model unavailable" };
const freeTier = { type: "provider.auth", status: 403, message: "free tier" };

function fakeRunner(outcomes) {
  const calls = [];
  const run = (model) => {
    calls.push(model);
    return outcomes[model];
  };
  return { run, calls };
}

describe("buildRunArgs", () => {
  it("runs a standalone JSON session for the agent and model", () => {
    assert.deepEqual(buildRunArgs("review", "openai/gpt-5#high"), [
      "run",
      "--standalone",
      "--agent",
      "review",
      "--model",
      "openai/gpt-5#high",
      "--format",
      "json",
      RUN_MESSAGE,
    ]);
  });

  it("never auto-approves permissions", () => {
    const args = buildRunArgs("plan", "a/b");
    for (const flag of ["--auto", "--yolo", "--dangerously-skip-permissions"]) {
      assert.equal(args.includes(flag), false, flag);
    }
  });
});

describe("runWithFallback", () => {
  it("returns the first model that answers", () => {
    const { run, calls } = fakeRunner({
      "a/x": { text: "", error: noRoute },
      "b/y": { text: "Answer" },
      "c/z": { text: "Unused" },
    });
    assert.deepEqual(
      runWithFallback(
        { origin: "variable", models: ["a/x", "b/y", "c/z"] },
        run,
      ),
      { ok: true, model: "b/y", text: "Answer", tried: ["a/x", "b/y"] },
    );
    assert.deepEqual(calls, ["a/x", "b/y"]);
  });

  it("skips free-tier refusals only for the curated defaults", () => {
    const outcomes = {
      "a/x": { text: "", error: freeTier },
      "b/y": { text: "Answer" },
    };
    assert.equal(
      runWithFallback(
        { origin: "default", models: ["a/x", "b/y"] },
        fakeRunner(outcomes).run,
      ).model,
      "b/y",
    );
    assert.deepEqual(
      runWithFallback(
        { origin: "variable", models: ["a/x", "b/y"] },
        fakeRunner(outcomes).run,
      ),
      {
        ok: false,
        model: "a/x",
        text: "",
        error: "provider.auth (HTTP 403): free tier",
        tried: ["a/x"],
      },
    );
  });

  it("explains when no model could run", () => {
    const result = runWithFallback(
      { origin: "default", models: ["a/x", "b/y"] },
      fakeRunner({
        "a/x": { text: "", error: noRoute },
        "b/y": { text: "", error: noRoute },
      }).run,
    );
    assert.equal(result.ok, false);
    assert.equal(result.model, undefined);
    assert.match(
      result.error,
      /tried a\/x, b\/y\)\. Last error: provider\.no-route/,
    );
  });

  it("treats an empty answer as a failure", () => {
    const result = runWithFallback(
      { origin: "default", models: ["a/x"] },
      fakeRunner({ "a/x": { text: "" } }).run,
    );
    assert.deepEqual(result, {
      ok: false,
      model: "a/x",
      text: "",
      error: "The agent finished without an answer.",
      tried: ["a/x"],
    });
  });
});

describe("footer", () => {
  it("names the agent, model, and run", () => {
    assert.equal(
      footer("plan", "opencode/x", "https://run"),
      "<sub>OpenCode · `plan` · `opencode/x` · [workflow run](https://run)</sub>",
    );
    assert.equal(
      footer("plan", undefined, "https://run"),
      "<sub>OpenCode · `plan` · [workflow run](https://run)</sub>",
    );
  });
});
