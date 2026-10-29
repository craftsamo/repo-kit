import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UsageError } from "../../src/errors.mts";
import { parseSyncLabelsArguments } from "../../src/github/sync-labels.mts";

describe("parseSyncLabelsArguments", () => {
  it("takes a repository and a dry run", () => {
    assert.deepEqual(parseSyncLabelsArguments([]), {
      repository: undefined,
      dryRun: false,
    });
    assert.deepEqual(
      parseSyncLabelsArguments(["--repo", "owner/repo", "--dry-run"]),
      { repository: "owner/repo", dryRun: true },
    );
  });

  it("reports a wrong argument as a usage error", () => {
    assert.throws(() => parseSyncLabelsArguments(["--repo"]), UsageError);
    assert.throws(() => parseSyncLabelsArguments(["--prune"]), UsageError);
  });
});
