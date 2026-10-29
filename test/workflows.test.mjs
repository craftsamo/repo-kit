// Guards what callers of the reusable workflows rely on.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveCommand } from "../src/main.mts";
import { packageRoot } from "../src/package-root.mts";

const directory = path.join(packageRoot, ".github/workflows");
const reusable = readdirSync(directory)
  .filter((file) => file.endsWith(".yml"))
  .map((file) => ({
    file,
    source: readFileSync(path.join(directory, file), "utf8"),
  }))
  .filter(({ source }) => /^ {2}workflow_call:/m.test(source));

// Lines of the file that are not comments, where the usage examples live.
const code = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("reusable workflows", () => {
  it("exist", () => {
    assert.deepEqual(reusable.map(({ file }) => file).sort(), [
      "labels-sync.yml",
      "opencode.yml",
      "release-draft.yml",
      "release-publish.yml",
    ]);
  });

  for (const { file, source } of reusable) {
    describe(file, () => {
      const body = code(source);

      // A caller allows third-party actions by its own workflows' uses, which
      // do not show these; GitHub-owned actions are always allowed.
      it("uses GitHub-owned actions only", () => {
        const actions = [
          ...body.matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/gm),
        ].map((match) => match[1]);
        assert.deepEqual(
          actions.filter((action) => !/^actions\/[^/]+@v\d+$/.test(action)),
          [],
        );
      });

      it("inherits no secrets", () => {
        assert.doesNotMatch(body, /secrets:\s*inherit/);
      });

      it("checks out repo-kit at the ref the caller pinned", () => {
        const checkouts = [
          ...body.matchAll(
            /repository: (.+)\n\s+ref: (.+)\n\s+path: repo-kit/g,
          ),
        ];
        assert.ok(checkouts.length > 0, "no checkout of repo-kit");
        for (const [, repository, ref] of checkouts) {
          assert.equal(repository, "${{ job.workflow_repository }}");
          assert.equal(ref, "${{ job.workflow_sha }}");
        }
      });

      it("runs only commands repo-kit has", () => {
        const runs = [...body.matchAll(/repo-kit\/src\/cli\.mts" ([a-z -]+)/g)];
        assert.ok(runs.length > 0, "runs no repo-kit command");
        for (const [, words] of runs) {
          assert.ok(
            resolveCommand(words.trim().split(" ")),
            `unknown command: ${words}`,
          );
        }
      });
    });
  }
});
