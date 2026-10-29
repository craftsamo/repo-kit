import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  countChangedLines,
  evaluateCommitSize,
  generatedPaths,
  numstatPaths,
  parseArguments,
  parseMaxChangedLines,
} from "../../src/hooks/commit-size.mts";

const cli = fileURLToPath(new URL("../../src/cli.mts", import.meta.url));

describe("countChangedLines", () => {
  it("counts additions and deletions", () => {
    const numstat = "12\t3\tsrc/example.ts\n4\t1\tsrc/other.ts\n";

    assert.equal(countChangedLines(numstat), 20);
  });

  it("excludes package manager lockfiles, in any directory", () => {
    const numstat =
      "600\t200\tpnpm-lock.yaml\n90\t9\tapps/api/Cargo.lock\n20\t5\tpackage.json\n";

    assert.equal(countChangedLines(numstat), 25);
  });

  it("does not count binary files as reviewable lines", () => {
    assert.equal(countChangedLines("-\t-\tpublic/image.png\n"), 0);
  });

  it("fails closed for malformed numstat output", () => {
    assert.throws(
      () => countChangedLines("not-numstat\n"),
      /Unexpected git numstat line/,
    );
  });
});

describe("evaluateCommitSize", () => {
  it("allows exactly 500 changed lines", () => {
    assert.deepEqual(evaluateCommitSize("300\t200\tsrc/example.ts\n"), {
      changedLines: 500,
      maxChangedLines: 500,
      passes: true,
    });
  });

  it("rejects 501 changed lines", () => {
    assert.deepEqual(evaluateCommitSize("301\t200\tsrc/example.ts\n"), {
      changedLines: 501,
      maxChangedLines: 500,
      passes: false,
    });
  });
});

describe("generated files", () => {
  it("reads linguist-generated from git check-attr output", () => {
    const output = [
      "db/meta/0001_snapshot.json",
      "linguist-generated",
      "set",
      "db/schema.ts",
      "linguist-generated",
      "unspecified",
      "db/other.json",
      "linguist-generated",
      "false",
      "api.gen.ts",
      "linguist-generated",
      "true",
      "",
    ].join("\0");

    assert.deepEqual(
      [...generatedPaths(output)],
      ["db/meta/0001_snapshot.json", "api.gen.ts"],
    );
  });

  it("leaves excluded paths out of the count", () => {
    const numstat = "541\t0\tdb/meta/0001_snapshot.json\n20\t5\tdb/schema.ts\n";

    assert.deepEqual(numstatPaths(numstat), [
      "db/meta/0001_snapshot.json",
      "db/schema.ts",
    ]);
    assert.equal(
      evaluateCommitSize(numstat, 500, new Set(["db/meta/0001_snapshot.json"]))
        .changedLines,
      25,
    );
  });

  it("lets a staged commit through when its large file is marked generated", () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-size-"));
    const git = (...args) => execFileSync("git", ["-C", repo, ...args]);
    const check = () =>
      spawnSync(process.execPath, [cli, "check", "commit-size"], {
        cwd: repo,
        encoding: "utf8",
      });

    try {
      git("init", "-q");
      writeFileSync(join(repo, "snapshot.json"), "x\n".repeat(600));
      writeFileSync(join(repo, "schema.ts"), "y\n".repeat(10));
      git("add", "snapshot.json", "schema.ts");

      const unmarked = check();
      assert.equal(unmarked.status, 1);
      assert.match(unmarked.stderr, /610 reviewable changed lines/);

      writeFileSync(
        join(repo, ".gitattributes"),
        "*.json linguist-generated\n",
      );
      assert.equal(
        check().status,
        1,
        "an unstaged .gitattributes does not count",
      );

      git("add", ".gitattributes");
      const marked = check();
      assert.equal(marked.status, 0, marked.stderr);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("parseMaxChangedLines", () => {
  it("uses 500 by default", () => {
    assert.equal(parseMaxChangedLines(undefined), 500);
  });

  it("accepts a positive integer", () => {
    assert.equal(parseMaxChangedLines("750"), 750);
  });

  it("rejects partial and fractional numbers", () => {
    assert.throws(
      () => parseMaxChangedLines("500abc"),
      /must be a positive integer/,
    );
    assert.throws(
      () => parseMaxChangedLines("500.5"),
      /must be a positive integer/,
    );
  });
});

describe("parseArguments", () => {
  it("takes the limit from --max, else MAX_COMMIT_CHANGED_LINES", () => {
    assert.equal(parseArguments([], {}).maxChangedLines, 500);
    assert.equal(
      parseArguments([], { MAX_COMMIT_CHANGED_LINES: "800" }).maxChangedLines,
      800,
    );
    assert.equal(
      parseArguments(["--max", "300"], { MAX_COMMIT_CHANGED_LINES: "800" })
        .maxChangedLines,
      300,
    );
    assert.throws(() => parseArguments(["--cached"], {}), /Unknown argument/);
  });
});
