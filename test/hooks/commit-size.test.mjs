import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  parseNumstat,
} from "../../src/hooks/commit-size.mts";

const cli = fileURLToPath(new URL("../../src/cli.mts", import.meta.url));
// The test repositories commit, so they need an author even where git has none set.
const GIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.test",
];

describe("parseNumstat", () => {
  it("parses normal entries", () => {
    const numstat = ["12\t3\tsrc/example.ts", "4\t1\tsrc/other.ts", ""].join(
      "\0",
    );
    assert.deepEqual(parseNumstat(numstat), [
      { additions: 12, deletions: 3, path: "src/example.ts" },
      { additions: 4, deletions: 1, path: "src/other.ts" },
    ]);
  });

  it("parses a rename entry and keeps the new path", () => {
    assert.deepEqual(parseNumstat("0\t0\t\0src/old.ts\0src/new.ts\0"), [
      { additions: 0, deletions: 0, path: "src/new.ts" },
    ]);
    assert.deepEqual(parseNumstat("5\t2\t\0src/old.ts\0src/new.ts\0"), [
      { additions: 5, deletions: 2, path: "src/new.ts" },
    ]);
  });

  it("parses binary entries as zero changed lines", () => {
    assert.deepEqual(parseNumstat("-\t-\tpublic/image.png\0"), [
      { additions: 0, deletions: 0, path: "public/image.png" },
    ]);
    assert.deepEqual(parseNumstat("-\t-\t\0public/old.png\0public/new.png\0"), [
      { additions: 0, deletions: 0, path: "public/new.png" },
    ]);
  });

  it("preserves paths containing spaces and tabs", () => {
    assert.deepEqual(parseNumstat("10\t5\tmy folder/file\tname.txt\0"), [
      { additions: 10, deletions: 5, path: "my folder/file\tname.txt" },
    ]);
    assert.deepEqual(
      parseNumstat("2\t1\t\0old dir/old\tfile.txt\0new dir/new\tfile.txt\0"),
      [{ additions: 2, deletions: 1, path: "new dir/new\tfile.txt" }],
    );
  });

  it("fails closed for malformed numstat output", () => {
    assert.throws(
      () => parseNumstat("not-numstat\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("12\tsrc/file.ts\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("abc\t1\tsrc/file.ts\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("1\tabc\tsrc/file.ts\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("-\t1\tsrc/file.ts\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("1\t-\tsrc/file.ts\0"),
      /Unexpected git numstat/,
    );
    assert.throws(
      () => parseNumstat("0\t0\t\0old.txt\0"),
      /Unexpected git numstat/,
    );
  });
});

describe("countChangedLines", () => {
  it("counts additions and deletions", () => {
    const numstat = ["12\t3\tsrc/example.ts", "4\t1\tsrc/other.ts", ""].join(
      "\0",
    );

    assert.equal(countChangedLines(numstat), 20);
  });

  it("excludes package manager lockfiles, in any directory", () => {
    const numstat = [
      "600\t200\tpnpm-lock.yaml",
      "90\t9\tapps/api/Cargo.lock",
      "20\t5\tpackage.json",
      "",
    ].join("\0");

    assert.equal(countChangedLines(numstat), 25);
  });

  it("excludes package manager lockfiles when moved based on the new path", () => {
    assert.equal(
      countChangedLines("50\t20\t\0old/pnpm-lock.yaml\0new/pnpm-lock.yaml\0"),
      0,
    );
    assert.equal(
      countChangedLines("50\t20\t\0old/foo.txt\0new/pnpm-lock.yaml\0"),
      0,
    );
    assert.equal(
      countChangedLines("50\t20\t\0old/pnpm-lock.yaml\0new/foo.txt\0"),
      70,
    );
  });

  it("does not count binary files as reviewable lines", () => {
    assert.equal(countChangedLines("-\t-\tpublic/image.png\0"), 0);
  });

  it("fails closed for malformed numstat output", () => {
    assert.throws(
      () => countChangedLines("not-numstat\0"),
      /Unexpected git numstat/,
    );
  });
});

describe("evaluateCommitSize", () => {
  it("allows exactly 500 changed lines", () => {
    assert.deepEqual(evaluateCommitSize("300\t200\tsrc/example.ts\0"), {
      changedLines: 500,
      maxChangedLines: 500,
      passes: true,
    });
  });

  it("rejects 501 changed lines", () => {
    assert.deepEqual(evaluateCommitSize("301\t200\tsrc/example.ts\0"), {
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
    const numstat = [
      "541\t0\tdb/meta/0001_snapshot.json",
      "20\t5\tdb/schema.ts",
      "",
    ].join("\0");

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
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...GIT_IDENTITY, ...args]);
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

describe("git renames", () => {
  it("passes for an unchanged move of a 600-line file", () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-size-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...GIT_IDENTITY, ...args]);
    const check = () =>
      spawnSync(process.execPath, [cli, "check", "commit-size"], {
        cwd: repo,
        encoding: "utf8",
      });

    try {
      git("init", "-q");
      writeFileSync(join(repo, "large.txt"), "line\n".repeat(600));
      git("add", "large.txt");
      git("commit", "-m", "init", "-q");

      git("mv", "large.txt", "moved.txt");
      const result = check();
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("counts only the changed lines when a moved file is edited", () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-size-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...GIT_IDENTITY, ...args]);
    const check = (...args) =>
      spawnSync(process.execPath, [cli, "check", "commit-size", ...args], {
        cwd: repo,
        encoding: "utf8",
      });

    try {
      git("init", "-q");
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i}\n`);
      writeFileSync(join(repo, "large.txt"), lines.join(""));
      git("add", "large.txt");
      git("commit", "-m", "init", "-q");

      git("mv", "large.txt", "moved.txt");
      lines[10] = "edited 10\n";
      lines[20] = "edited 20\n";
      lines[30] = "edited 30\n";
      writeFileSync(join(repo, "moved.txt"), lines.join(""));
      git("add", "moved.txt");

      const failing = check("--max", "5");
      assert.equal(failing.status, 1);
      assert.match(failing.stderr, /6 reviewable changed lines/);

      const passing = check("--max", "6");
      assert.equal(passing.status, 0, passing.stderr);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails when a file is deleted and a different file added beyond git rename threshold", () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-size-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...GIT_IDENTITY, ...args]);
    const check = () =>
      spawnSync(process.execPath, [cli, "check", "commit-size"], {
        cwd: repo,
        encoding: "utf8",
      });

    try {
      git("init", "-q");
      writeFileSync(join(repo, "fileA.txt"), "alpha\n".repeat(600));
      git("add", "fileA.txt");
      git("commit", "-m", "init", "-q");

      git("rm", "-q", "fileA.txt");
      writeFileSync(join(repo, "fileB.txt"), "beta\n".repeat(600));
      git("add", "fileB.txt");

      const result = check();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /1200 reviewable changed lines/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes a moved file marked linguist-generated in .gitattributes", () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-size-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...GIT_IDENTITY, ...args]);
    const check = (...args) =>
      spawnSync(process.execPath, [cli, "check", "commit-size", ...args], {
        cwd: repo,
        encoding: "utf8",
      });

    try {
      git("init", "-q");
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i}\n`);
      writeFileSync(join(repo, "large.txt"), lines.join(""));
      git("add", "large.txt");
      git("commit", "-m", "init", "-q");

      mkdirSync(join(repo, "dist"), { recursive: true });
      git("mv", "large.txt", "dist/large.txt");
      lines[10] = "edited 10\n";
      lines[20] = "edited 20\n";
      lines[30] = "edited 30\n";
      writeFileSync(join(repo, "dist/large.txt"), lines.join(""));
      git("add", "dist/large.txt");

      const unmarked = check("--max", "5");
      assert.equal(unmarked.status, 1);
      assert.match(unmarked.stderr, /6 reviewable changed lines/);

      writeFileSync(
        join(repo, ".gitattributes"),
        "dist/* linguist-generated\n",
      );
      git("add", ".gitattributes");

      const marked = check("--max", "5");
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
