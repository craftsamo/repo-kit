import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveRepositoryRoot } from "../src/repository-root.mts";

function temporaryDirectory(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "root-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("resolveRepositoryRoot", () => {
  it("prefers REPOSITORY_ROOT, resolved against the current directory", (t) => {
    const cwd = temporaryDirectory(t);
    assert.equal(
      resolveRepositoryRoot({ REPOSITORY_ROOT: "consumer" }, cwd),
      path.join(cwd, "consumer"),
    );
  });

  it("finds the top of the git worktree from a subdirectory", (t) => {
    const root = temporaryDirectory(t);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const nested = path.join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveRepositoryRoot({}, nested), root);
  });

  it("falls back to the current directory outside a git worktree", (t) => {
    const cwd = temporaryDirectory(t);
    assert.equal(resolveRepositoryRoot({}, cwd), cwd);
  });
});
