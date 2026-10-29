import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseDefaultModels,
  parseModelList,
  resolveModelSource,
  shouldTryNextModel,
} from "../../../src/ci/opencode/models.mts";

const defaults = {
  source: "https://example.com",
  checkedAt: "2026-10-10",
  policy: "test",
  candidates: ["opencode/a-free", "opencode/b-free"],
};

describe("parseModelList", () => {
  it("splits on commas and newlines and keeps variants", () => {
    assert.deepEqual(
      parseModelList(" openai/gpt-5#high,\nanthropic/claude , ", "X"),
      ["openai/gpt-5#high", "anthropic/claude"],
    );
  });

  it("allows nested provider model IDs", () => {
    assert.deepEqual(parseModelList("openrouter/openai/gpt-5-mini", "X"), [
      "openrouter/openai/gpt-5-mini",
    ]);
  });

  it("rejects values that are not provider/model IDs", () => {
    assert.throws(
      () => parseModelList("gpt-5", "OPENCODE_MODEL"),
      /OPENCODE_MODEL: "gpt-5"/,
    );
    assert.throws(
      () => parseModelList("openai/gpt-5#a#b", "X"),
      /not a model ID/,
    );
  });
});

describe("parseDefaultModels", () => {
  it("reads the candidate list", () => {
    const parsed = parseDefaultModels(JSON.stringify(defaults));
    assert.deepEqual(parsed.candidates, defaults.candidates);
    assert.equal(parsed.checkedAt, "2026-10-10");
  });

  it("rejects an empty or malformed candidate list", () => {
    assert.throws(() => parseDefaultModels('{"candidates":[]}'), /non-empty/);
    assert.throws(() => parseDefaultModels('{"candidates":"x"}'), /non-empty/);
    assert.throws(
      () => parseDefaultModels('{"candidates":["nope"]}'),
      /not a model ID/,
    );
  });
});

describe("resolveModelSource", () => {
  it("prefers the per-agent variable", () => {
    assert.deepEqual(
      resolveModelSource(
        "review",
        {
          OPENCODE_MODEL_REVIEW: "openai/gpt-5#high",
          OPENCODE_MODEL: "anthropic/claude",
        },
        defaults,
      ),
      {
        origin: "variable",
        variable: "OPENCODE_MODEL_REVIEW",
        models: ["openai/gpt-5#high"],
      },
    );
  });

  it("falls back to the shared variable, ignoring blank values", () => {
    assert.deepEqual(
      resolveModelSource(
        "plan",
        { OPENCODE_MODEL_PLAN: " ", OPENCODE_MODEL: "a/b,c/d" },
        defaults,
      ),
      {
        origin: "variable",
        variable: "OPENCODE_MODEL",
        models: ["a/b", "c/d"],
      },
    );
  });

  it("uses the curated defaults when no variable is set", () => {
    assert.deepEqual(resolveModelSource("debug", {}, defaults), {
      origin: "default",
      models: defaults.candidates,
    });
  });

  it("skips default candidates whose provider key is missing", () => {
    const withOpenRouter = {
      ...defaults,
      candidates: [...defaults.candidates, "openrouter/x/y:free"],
    };
    assert.deepEqual(
      resolveModelSource("plan", {}, withOpenRouter).models,
      defaults.candidates,
    );
    assert.deepEqual(
      resolveModelSource("plan", { OPENROUTER_API_KEY: " " }, withOpenRouter)
        .models,
      defaults.candidates,
    );
    assert.deepEqual(
      resolveModelSource("plan", { OPENROUTER_API_KEY: "k" }, withOpenRouter)
        .models,
      withOpenRouter.candidates,
    );
  });

  it("keeps a configured model even without its key", () => {
    assert.deepEqual(
      resolveModelSource(
        "plan",
        { OPENCODE_MODEL: "openrouter/x/y:free" },
        defaults,
      ).models,
      ["openrouter/x/y:free"],
    );
  });
});

describe("shouldTryNextModel", () => {
  it("moves on when the model is unreachable", () => {
    assert.equal(
      shouldTryNextModel("variable", { type: "provider.no-route" }),
      true,
    );
    assert.equal(
      shouldTryNextModel("default", { type: "provider.no-route" }),
      true,
    );
  });

  it("skips free-tier refusals only for the curated defaults", () => {
    const refusal = { type: "provider.auth", status: 403 };
    assert.equal(shouldTryNextModel("default", refusal), true);
    assert.equal(shouldTryNextModel("variable", refusal), false);
  });

  it("stops on success and on other errors", () => {
    assert.equal(shouldTryNextModel("default", undefined), false);
    assert.equal(
      shouldTryNextModel("default", { type: "provider.auth", status: 401 }),
      false,
    );
    assert.equal(shouldTryNextModel("default", { type: "unknown" }), false);
  });
});
