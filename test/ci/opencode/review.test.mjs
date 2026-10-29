import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReviewPayload,
  commentableLines,
  parseReviewOutput,
  unquoteGitPath,
} from "../../../src/ci/opencode/review.mts";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  "@@ -20,2 +21,2 @@ function f() {",
  " keep();",
  "-old();",
  "+next();",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-removed",
  "diff --git a/new.md b/new.md",
  "--- /dev/null",
  "+++ b/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+",
  "\\ No newline at end of file",
].join("\n");

describe("commentableLines", () => {
  it("collects added and context lines on the new side", () => {
    const lines = commentableLines(diff);
    assert.deepEqual(
      [...lines.get("src/a.ts")].sort((x, y) => x - y),
      [1, 2, 3, 4, 21, 22],
    );
    assert.deepEqual([...lines.get("new.md")], [1, 2]);
    assert.equal(lines.has("gone.ts"), false);
  });

  it("does not mistake an added '++' line for a file header", () => {
    const lines = commentableLines(
      [
        "diff --git a/c.txt b/c.txt",
        "--- a/c.txt",
        "+++ b/c.txt",
        "@@ -1 +1,2 @@",
        " keep",
        "+++ counter",
      ].join("\n"),
    );
    assert.deepEqual([...lines.keys()], ["c.txt"]);
    assert.deepEqual([...lines.get("c.txt")], [1, 2]);
  });

  it("reads quoted paths", () => {
    const lines = commentableLines(
      [
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        '--- "a/caf\\303\\251.ts"',
        '+++ "b/caf\\303\\251.ts"',
        "@@ -1 +1 @@",
        "+x",
      ].join("\n"),
    );
    assert.deepEqual([...lines.keys()], ["café.ts"]);
  });
});

describe("unquoteGitPath", () => {
  it("decodes C-style escapes and leaves plain paths alone", () => {
    assert.equal(unquoteGitPath("b/plain.ts"), "b/plain.ts");
    assert.equal(unquoteGitPath('"b/a\\"q\\\\.ts"'), 'b/a"q\\.ts');
    assert.equal(unquoteGitPath('"b/\\346\\227\\245.md"'), "b/日.md");
  });
});

describe("parseReviewOutput", () => {
  it("reads the last json block and drops malformed findings", () => {
    const text = [
      "Some notes.",
      "```json",
      '{"summary": "old"}',
      "```",
      "```json",
      JSON.stringify({
        summary: " Looks mostly fine. ",
        comments: [
          { path: "src/a.ts", line: 3, body: "Off by one?" },
          { path: "src/a.ts", line: 4, start_line: 2, body: "Range" },
          { path: "src/a.ts", line: 4, start_line: 9, body: "Bad range" },
          { path: "src/a.ts", line: "x", body: "no line" },
          { line: 2, body: "no path" },
        ],
      }),
      "```",
    ].join("\n");

    assert.deepEqual(parseReviewOutput(text), {
      summary: "Looks mostly fine.",
      findings: [
        { path: "src/a.ts", line: 3, body: "Off by one?" },
        { path: "src/a.ts", line: 4, startLine: 2, body: "Range" },
        { path: "src/a.ts", line: 4, body: "Bad range" },
      ],
    });
  });

  it("keeps reading past suggestion fences quoted inside JSON strings", () => {
    const body = "**Bug**: x\n```suggestion\nconst b = 4;\n```";
    const text = [
      "```json",
      JSON.stringify(
        { summary: "One.", comments: [{ path: "src/a.ts", line: 3, body }] },
        null,
        2,
      ),
      "```",
      "",
    ].join("\n");
    assert.deepEqual(parseReviewOutput(text), {
      summary: "One.",
      findings: [{ path: "src/a.ts", line: 3, body }],
    });
  });

  it("returns undefined without a parsable json block", () => {
    assert.equal(parseReviewOutput("No block here"), undefined);
    assert.equal(parseReviewOutput("```json\n{oops\n```"), undefined);
  });
});

describe("buildReviewPayload", () => {
  const options = {
    commitId: "abc123",
    permalinkBase: "https://github.com/o/r/blob/abc123",
    footer: "<sub>footer</sub>",
  };

  it("places findings inside the diff inline and the rest in the body", () => {
    const payload = buildReviewPayload(
      {
        summary: "Two findings.",
        findings: [
          { path: "src/a.ts", line: 3, startLine: 2, body: "Inline range" },
          { path: "src/a.ts", line: 22, startLine: 10, body: "Start outside" },
          { path: "src/other.ts", line: 5, body: "Not in diff" },
        ],
      },
      commentableLines(diff),
      options,
    );

    assert.equal(payload.commit_id, "abc123");
    assert.equal(payload.event, "COMMENT");
    assert.deepEqual(payload.comments, [
      {
        path: "src/a.ts",
        line: 3,
        side: "RIGHT",
        start_line: 2,
        start_side: "RIGHT",
        body: "Inline range",
      },
      { path: "src/a.ts", line: 22, side: "RIGHT", body: "Start outside" },
    ]);
    assert.equal(
      payload.body,
      [
        "Two findings.",
        "**Findings outside the diff**",
        "**[`src/other.ts:5`](https://github.com/o/r/blob/abc123/src/other.ts#L5)**",
        "Not in diff",
        "<sub>footer</sub>",
      ].join("\n\n"),
    );
  });

  it("drops a range that spans two hunks", () => {
    const payload = buildReviewPayload(
      {
        summary: "",
        findings: [
          { path: "src/a.ts", line: 21, startLine: 3, body: "Across hunks" },
        ],
      },
      commentableLines(diff),
      options,
    );
    assert.deepEqual(payload.comments, [
      { path: "src/a.ts", line: 21, side: "RIGHT", body: "Across hunks" },
    ]);
  });

  it("encodes link paths and keeps multi-line bodies intact", () => {
    const payload = buildReviewPayload(
      {
        summary: "One finding.",
        findings: [
          {
            path: "docs/my file.md",
            line: 9,
            startLine: 7,
            body: "First line\n```suggestion\nfixed\n```",
          },
        ],
      },
      new Map(),
      options,
    );
    assert.match(
      payload.body,
      /\*\*\[`docs\/my file\.md:9`\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/docs\/my%20file\.md#L7-L9\)\*\*\n\nFirst line\n```suggestion\nfixed\n```/,
    );
  });

  it("states when there is nothing to report", () => {
    const payload = buildReviewPayload(
      { summary: "", findings: [] },
      new Map(),
      options,
    );
    assert.equal(payload.body, "No issues found.\n\n<sub>footer</sub>");
    assert.deepEqual(payload.comments, []);
  });
});
