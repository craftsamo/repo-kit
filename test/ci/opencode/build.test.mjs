import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBranchName,
  fallbackBuildSummary,
  neutralizeClosingKeywords,
  parseBuildOutput,
  pullRequestBody,
  workflowChanges,
} from "../../../src/ci/opencode/build.mts";

const block = (value) =>
  ["Done.", "```json", JSON.stringify(value), "```"].join("\n");

describe("parseBuildOutput", () => {
  it("reads the title, commit message, and summary", () => {
    assert.deepEqual(
      parseBuildOutput(
        block({
          title: " Add workspace list command \nextra",
          commit: "feat: add workspace list command\n\nPrint names.",
          summary: "- Adds `nps info.packages`",
        }),
      ),
      {
        title: "Add workspace list command",
        commitMessage: "feat: add workspace list command\n\nPrint names.",
        summary: "- Adds `nps info.packages`",
      },
    );
  });

  it("clips long titles", () => {
    const parsed = parseBuildOutput(
      block({ title: "x".repeat(100), commit: "fix: y", summary: "z" }),
    );
    assert.equal(parsed.title.length, 72);
    assert.match(parsed.title, /…$/);
  });

  it("rejects missing fields and unparsable blocks", () => {
    assert.equal(
      parseBuildOutput(block({ title: "t", commit: "", summary: "s" })),
      undefined,
    );
    assert.equal(
      parseBuildOutput(block({ title: "t", commit: "c" })),
      undefined,
    );
    assert.equal(parseBuildOutput("no block"), undefined);
    assert.equal(parseBuildOutput("```json\n{oops\n```"), undefined);
  });
});

describe("fallbackBuildSummary", () => {
  it("derives the title from the instruction", () => {
    assert.deepEqual(
      fallbackBuildSummary(" Changed files. ", "add tests\nfor login", 7),
      {
        title: "add tests",
        commitMessage: "chore: add tests\n\nRequested in #7.",
        summary: "Changed files.",
      },
    );
  });

  it("works without an instruction or output", () => {
    assert.deepEqual(fallbackBuildSummary("", "", 3), {
      title: "Apply /oc build for #3",
      commitMessage: "chore: Apply /oc build for #3\n\nRequested in #3.",
      summary: "The agent did not describe its changes.",
    });
  });
});

describe("buildBranchName", () => {
  it("names the branch after the issue, run, and attempt", () => {
    assert.equal(buildBranchName(12, "987", "2"), "opencode/issue-12-987-2");
  });
});

describe("workflowChanges", () => {
  it("finds changes GITHUB_TOKEN cannot push", () => {
    assert.deepEqual(
      workflowChanges([
        ".github/workflows/tests.yml",
        ".github/opencode/models.json",
        "a.ts",
      ]),
      [".github/workflows/tests.yml"],
    );
  });
});

describe("neutralizeClosingKeywords", () => {
  it("turns references after closing keywords into code spans", () => {
    assert.equal(
      neutralizeClosingKeywords("Fixes #3, closes: o/r#4. See #5. Resolved #6"),
      "Fixes `#3`, closes: `o/r#4`. See #5. Resolved `#6`",
    );
  });
});

describe("pullRequestBody", () => {
  it("only closes the requesting issue", () => {
    assert.equal(
      pullRequestBody("Also fixes #9", 5, "f"),
      "Also fixes `#9`\n\nCloses #5\n\nf",
    );
  });

  it("closes the issue and keeps the footer last", () => {
    assert.equal(
      pullRequestBody("Summary", 5, "<sub>f</sub>"),
      "Summary\n\nCloses #5\n\n<sub>f</sub>",
    );
  });
});
