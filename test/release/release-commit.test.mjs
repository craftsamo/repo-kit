// The release flow against a real repository with a bare remote. The
// repository the commands work on is the clone, named before they first use it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { bumpMain, sync } from "../../src/release/release.mts";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "release-flow-")));
const root = path.join(base, "work");
const remote = path.join(base, "origin.git");
process.env.REPOSITORY_ROOT = root;

const PACKAGE = `${JSON.stringify({ name: "app", version: "1.0.0", scripts: { version: "x" } }, null, 2)}\n`;
const CHART =
  "apiVersion: v2\nname: chart\nversion: 1.0.0\nappVersion: 1.0.0\n";

const gitOutput = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const git = (cwd, ...args) => gitOutput(cwd, ...args).trim();

const write = (file, content) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

const commit = (message) => {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const remoteMain = () => git(remote, "rev-parse", "refs/heads/main");
const remoteFile = (file) =>
  gitOutput(remote, "show", `refs/heads/main:${file}`);

const options = (versionFiles = []) => ({ versionFiles });

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(base, "clone", "--quiet", remote, root);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.test"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ]) {
    git(root, "config", key, value);
  }
  git(root, "checkout", "--quiet", "-B", "main");
  write("package.json", PACKAGE);
  write("chart/Chart.yaml", CHART);
  commit("chore: start");
  git(root, "push", "--quiet", "-u", "origin", "main");
  mock.method(console, "log", () => {});
});

afterEach(() => {
  mock.restoreAll();
});

describe("bumpMain", () => {
  it("sets the version in package.json and the version files in one commit", () => {
    const start = remoteMain();
    const result = bumpMain(start, "1.1.0", options(["chart/Chart.yaml"]));

    assert.equal(result.pushed, true);
    assert.equal(result.head, remoteMain());
    assert.equal(git(remote, "rev-parse", `${result.head}^`), start);
    assert.equal(
      remoteFile("chart/Chart.yaml"),
      CHART.replace("version: 1.0.0", "version: 1.1.0"),
    );
    assert.equal(
      remoteFile("package.json"),
      PACKAGE.replace('"version": "1.0.0"', '"version": "1.1.0"'),
    );
    assert.equal(
      git(remote, "log", "-1", "--format=%s", "refs/heads/main"),
      "chore(release): set the version to 1.1.0",
    );
  });

  it("bumps a version file that lags behind a manifest already at the version", () => {
    write("package.json", PACKAGE.replace("1.0.0", "1.1.0"));
    commit("chore: bump by hand");
    git(root, "push", "--quiet");
    const start = remoteMain();

    const result = bumpMain(start, "1.1.0", options(["chart/Chart.yaml"]));

    assert.equal(result.pushed, true);
    assert.equal(git(remote, "rev-parse", `${result.head}^`), start);
    assert.match(remoteFile("chart/Chart.yaml"), /^version: 1\.1\.0$/m);
  });

  it("pushes nothing when everything already carries the version", () => {
    const start = remoteMain();
    const result = bumpMain(start, "1.0.0", options(["chart/Chart.yaml"]));
    assert.deepEqual(result, { pushed: false, head: start });
    assert.equal(remoteMain(), start);
  });

  it("fails before pushing when a version file is missing or has no version", () => {
    write("chart/empty.yaml", "name: chart\n");
    commit("chore: add a chart without a version");
    git(root, "push", "--quiet");
    const start = remoteMain();

    assert.throws(
      () => bumpMain(start, "1.1.0", options(["chart/missing.yaml"])),
      /The version file chart\/missing\.yaml does not exist/,
    );
    assert.throws(
      () =>
        bumpMain(
          start,
          "1.1.0",
          options(["chart/Chart.yaml", "chart/empty.yaml"]),
        ),
      /chart\/empty\.yaml has no top-level version field/,
    );
    assert.equal(remoteMain(), start);
  });

  it("leaves no temporary worktree behind", () => {
    bumpMain(remoteMain(), "1.1.0", options());
    assert.equal(
      git(root, "worktree", "list", "--porcelain").match(/^worktree /gm).length,
      1,
    );
  });
});

describe("sync of a given version", () => {
  it("sets the version files with package.json in the checkout and pushes", () => {
    sync(["--version", "1.1.0", "--version-file", "chart/Chart.yaml"]);
    assert.equal(
      remoteFile("chart/Chart.yaml"),
      CHART.replace("version: 1.0.0", "version: 1.1.0"),
    );
    assert.match(remoteFile("package.json"), /"version": "1.1.0"/);
    assert.equal(git(remote, "rev-list", "--count", "refs/heads/main"), "2");
  });

  it("changes nothing when a version file is missing", () => {
    const start = remoteMain();
    assert.throws(
      () => sync(["--version", "1.1.0", "--version-file", "nope.json"]),
      /does not exist/,
    );
    assert.equal(remoteMain(), start);
    assert.equal(
      readFileSync(path.join(root, "package.json"), "utf8"),
      PACKAGE,
    );
  });
});
