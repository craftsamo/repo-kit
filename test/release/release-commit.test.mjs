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

import { bumpMain, commitsInRange, sync } from "../../src/release/release.mts";

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

const options = (versionFiles = [], build) => ({
  versionFiles,
  ...(build ? { build } : {}),
});

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
  write(".gitignore", "dist/\n");
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
    assert.equal(result.release, undefined);
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

describe("bumpMain with a build", () => {
  const build = (command, artifacts = ["dist"]) => ({ command, artifacts });

  it("commits the artifacts in a release commit above the version commit", () => {
    process.env.RELEASE_TEST_VALUE = "inherited";
    const start = remoteMain();
    const result = bumpMain(
      start,
      "1.1.0",
      options(
        ["chart/Chart.yaml"],
        build(
          [
            "mkdir -p dist/nested",
            "echo built > dist/app.js",
            "echo nested > dist/nested/lib.js",
            'basename "$(pwd)" > dist/cwd.txt',
            'basename "$REPOSITORY_ROOT" > dist/root.txt',
            'echo "$RELEASE_TEST_VALUE" > dist/env.txt',
            // The build may leave other files; only the artifacts are kept.
            "echo scratch > scratch.txt",
          ].join(" && "),
        ),
      ),
    );
    delete process.env.RELEASE_TEST_VALUE;

    // main takes the version commit and no build output.
    assert.equal(result.pushed, true);
    assert.equal(remoteMain(), result.head);
    assert.equal(git(remote, "rev-parse", `${result.head}^`), start);
    assert.doesNotMatch(
      git(remote, "ls-tree", "-r", "--name-only", result.head),
      /dist/,
    );

    // The release commit sits above it and is not on the remote.
    assert.ok(result.release);
    assert.notEqual(result.release, result.head);
    assert.equal(git(root, "rev-parse", `${result.release}^`), result.head);
    assert.equal(
      git(root, "log", "-1", "--format=%s", result.release),
      "chore(release): build 1.1.0",
    );
    assert.doesNotMatch(
      git(root, "ls-tree", "-r", "--name-only", result.release),
      /scratch/,
    );
    assert.deepEqual(
      git(root, "diff", "--name-only", result.head, result.release).split("\n"),
      [
        "dist/app.js",
        "dist/cwd.txt",
        "dist/env.txt",
        "dist/nested/lib.js",
        "dist/root.txt",
      ],
    );
    const shown = (file) => git(root, "show", `${result.release}:${file}`);
    assert.equal(shown("dist/app.js"), "built");
    assert.match(shown("dist/cwd.txt"), /^release-/);
    assert.equal(shown("dist/root.txt"), shown("dist/cwd.txt"));
    assert.equal(shown("dist/env.txt"), "inherited");
    assert.throws(() => git(remote, "cat-file", "-e", result.release));
    assert.equal(git(remote, "tag", "--list"), "");
  });

  it("runs the build without the job's credentials or a way to push over ssh", () => {
    const credentials = {
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test",
      ACTIONS_RUNTIME_TOKEN: "runtime-secret",
      GIT_SSH_COMMAND: "ssh -i /runner/deploy-key",
      RELEASE_TEST_KEPT: "kept",
    };
    Object.assign(process.env, credentials);
    let result;
    try {
      result = bumpMain(
        remoteMain(),
        "1.1.0",
        options([], build("mkdir dist && env > dist/env.txt")),
      );
    } finally {
      for (const name of Object.keys(credentials)) delete process.env[name];
    }

    const printed = git(root, "show", `${result.release}:dist/env.txt`);
    const seen = Object.fromEntries(
      printed
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    assert.deepEqual(
      Object.keys(seen).filter((name) =>
        /^(GH_TOKEN|GITHUB_TOKEN|ACTIONS_)/.test(name),
      ),
      [],
    );
    assert.doesNotMatch(printed, /secret/);
    assert.equal(seen.GIT_SSH_COMMAND, "false");
    assert.equal(seen.RELEASE_TEST_KEPT, "kept");
    assert.match(seen.REPOSITORY_ROOT, /release-/);
  });

  it("builds on main as it is when it already carries the version", () => {
    const start = remoteMain();
    const result = bumpMain(
      start,
      "1.0.0",
      options([], build("mkdir dist && echo built > dist/app.js")),
    );
    assert.equal(result.pushed, false);
    assert.equal(result.head, start);
    assert.equal(git(root, "rev-parse", `${result.release}^`), start);
    assert.equal(remoteMain(), start);
  });

  it("fails before pushing when the build fails", () => {
    const start = remoteMain();
    assert.throws(
      () =>
        bumpMain(
          start,
          "1.1.0",
          options([], build("mkdir dist && echo half > dist/app.js && exit 3")),
        ),
      /The build command exited with 3/,
    );
    assert.equal(remoteMain(), start);
  });

  it("fails before pushing when an artifact was not produced", () => {
    const start = remoteMain();
    assert.throws(
      () =>
        bumpMain(
          start,
          "1.1.0",
          options(
            [],
            build("mkdir dist && echo built > dist/app.js", [
              "dist",
              "bundle.js",
            ]),
          ),
        ),
      /The build did not produce bundle\.js/,
    );
    assert.equal(remoteMain(), start);
  });

  it("fails before pushing when the artifacts hold nothing to commit", () => {
    const start = remoteMain();
    assert.throws(
      () => bumpMain(start, "1.1.0", options([], build("mkdir dist"))),
      /nothing to commit in dist/,
    );
    assert.equal(remoteMain(), start);
  });

  it("fails before the build when a version file is missing", () => {
    const start = remoteMain();
    assert.throws(
      () =>
        bumpMain(
          start,
          "1.1.0",
          options(
            ["chart/missing.yaml"],
            build("mkdir dist && echo x > dist/a"),
          ),
        ),
      /does not exist/,
    );
    assert.equal(remoteMain(), start);
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

describe("commitsInRange", () => {
  it("lists the commits after a tag on a release commit above main", () => {
    const first = git(root, "rev-parse", "HEAD");
    const { head, release } = bumpMain(
      first,
      "1.1.0",
      options([], {
        command: "mkdir dist && echo built > dist/app.js",
        artifacts: ["dist"],
      }),
    );
    git(root, "tag", "v1.1.0", release);
    git(root, "pull", "--quiet", "--ff-only");
    write("later.txt", "one");
    const later = commit("feat: after the release");
    write("later.txt", "two");
    const last = commit("fix: and again");

    assert.equal(git(root, "rev-parse", "HEAD~2"), head);
    assert.deepEqual(commitsInRange("v1.1.0", last), new Set([later, last]));
    assert.equal(commitsInRange(undefined, last).size, 4);
    assert.equal(commitsInRange(undefined, last).has(release), false);
  });

  it("lists the commits after a tag on a version commit as well", () => {
    const { head } = bumpMain(remoteMain(), "1.1.0", options());
    git(root, "tag", "v1.1.0", head);
    git(root, "pull", "--quiet", "--ff-only");
    write("later.txt", "more");
    const later = commit("fix: after the release");
    assert.deepEqual(commitsInRange("v1.1.0", later), new Set([later]));
  });
});
