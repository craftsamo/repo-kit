import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CommandError,
  ensureEnvironment,
  environmentExists,
} from "../../src/github/gh.mts";

const httpError = (status, message) =>
  new CommandError("gh api", { stderr: `gh: ${message} (HTTP ${status})` });

describe("CommandError", () => {
  it("keeps the HTTP status gh reports", () => {
    const error = httpError(404, "Not Found");

    assert.equal(error.httpStatus, 404);
    assert.equal(error.message, "gh: Not Found (HTTP 404)");
    assert.ok(Number.isNaN(new CommandError("gh", {}).httpStatus));
  });
});

describe("deployment environments", () => {
  const recorder = (respond) => {
    const calls = [];
    const request = (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      return respond(method);
    };
    return { calls, request };
  };

  it("creates a missing environment with a single upsert", () => {
    const { calls, request } = recorder((method) => {
      if (method === "GET") throw httpError(404, "Not Found");
      return undefined;
    });

    assert.equal(ensureEnvironment("owner/repo", "production", request), true);
    assert.deepEqual(calls, [
      {
        method: "GET",
        endpoint: "/repos/owner/repo/environments/production",
        body: undefined,
      },
      {
        method: "PUT",
        endpoint: "/repos/owner/repo/environments/production",
        body: {},
      },
    ]);
  });

  it("leaves an existing environment untouched so protection rules survive", () => {
    const { calls, request } = recorder(() => ({ name: "production" }));

    assert.equal(ensureEnvironment("owner/repo", "production", request), false);
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["GET"],
    );
  });

  it("propagates a non-404 lookup failure instead of overwriting", () => {
    const { calls, request } = recorder(() => {
      throw httpError(403, "Forbidden");
    });

    assert.throws(
      () => ensureEnvironment("owner/repo", "production", request),
      /Forbidden/,
    );
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["GET"],
    );
  });

  it("escapes the environment name in the endpoint path", () => {
    const { calls, request } = recorder(() => ({}));

    assert.equal(environmentExists("owner/repo", "staging/eu", request), true);
    assert.equal(
      calls[0].endpoint,
      "/repos/owner/repo/environments/staging%2Feu",
    );
  });
});
