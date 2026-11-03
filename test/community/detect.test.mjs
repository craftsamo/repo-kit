import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  detectProject,
  readCommitSubjects,
  readReleaseLabels,
  usesConventionalCommits,
} from "../../src/community/detect.mts";

function createRepo(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "detect-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createGitRepo(t) {
  const root = createRepo(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

describe("readCommitSubjects", () => {
  it("returns an empty list for a repository without commits", (t) => {
    const root = createGitRepo(t);
    assert.deepEqual(readCommitSubjects(root), []);
  });

  it("returns commit subjects newest first for a repository with commits", (t) => {
    const root = createGitRepo(t);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "feat: first commit",
      ],
      { cwd: root },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "fix: second commit",
      ],
      { cwd: root },
    );

    assert.deepEqual(readCommitSubjects(root), [
      "fix: second commit",
      "feat: first commit",
    ]);
  });
});

describe("usesConventionalCommits", () => {
  it("returns true when at least 5 subjects and at least half match", () => {
    assert.equal(
      usesConventionalCommits([
        "feat: one",
        "fix(core): two",
        "refactor!: three",
        "docs(api)!: four",
        "chore: five",
      ]),
      true,
    );

    assert.equal(
      usesConventionalCommits([
        "feat: one",
        "fix: two",
        "docs: three",
        "random message one",
        "random message two",
      ]),
      true,
    );
  });

  it("returns false when less than half match", () => {
    assert.equal(
      usesConventionalCommits([
        "feat: one",
        "fix: two",
        "random message one",
        "random message two",
        "random message three",
      ]),
      false,
    );
  });

  it("returns false when there are fewer than 5 subjects", () => {
    assert.equal(
      usesConventionalCommits([
        "feat: one",
        "fix: two",
        "docs: three",
        "chore: four",
      ]),
      false,
    );
    assert.equal(usesConventionalCommits([]), false);
  });
});

describe("readReleaseLabels", () => {
  it("converts .github/release-notes.json with first effect winning", (t) => {
    const root = createRepo(t);
    mkdirSync(path.join(root, ".github"), { recursive: true });
    writeFileSync(
      path.join(root, ".github", "release-notes.json"),
      JSON.stringify({
        name: "v{version}",
        tagPrefix: "v",
        major: ["breaking", "dupe"],
        exclude: ["skip-changelog", "dupe"],
        titleEscapes: "",
        categories: [
          {
            title: "Features",
            labels: ["feature", "dupe"],
            increment: "minor",
          },
          { title: "Fixes", labels: ["fix", "patch-only"] },
          { title: "Other" },
        ],
      }),
    );

    assert.deepEqual(readReleaseLabels(root), [
      { label: "breaking", effect: "major" },
      { label: "dupe", effect: "major" },
      { label: "skip-changelog", effect: "excluded" },
      { label: "feature", effect: "minor" },
      { label: "fix", effect: "patch" },
      { label: "patch-only", effect: "patch" },
    ]);
  });

  it("reads default release labels when workflow references release-draft.yml", (t) => {
    const root = createRepo(t);
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github", "workflows", "release.yml"),
      "jobs:\n  draft:\n    uses: craftsamo/repo-kit/.github/workflows/release-draft.yml@v1\n",
    );

    assert.deepEqual(readReleaseLabels(root), [
      { label: "skip-changelog", effect: "excluded" },
    ]);
  });

  it("returns undefined when no release config or workflow matches", (t) => {
    const root = createRepo(t);
    assert.equal(readReleaseLabels(root), undefined);

    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
    );
    assert.equal(readReleaseLabels(root), undefined);
  });
});

describe("detectProject", () => {
  it("handles absent package.json", (t) => {
    const root = createRepo(t);
    const info = detectProject(root, []);

    assert.deepEqual(info, {
      corepack: false,
      checks: [],
      conventionalCommits: false,
      agentsFile: false,
    });
    assert.equal("packageManager" in info, false);
    assert.equal("nodeVersion" in info, false);
    assert.equal("install" in info, false);
    assert.equal("release" in info, false);
  });

  it("throws when package.json is invalid JSON", (t) => {
    const root = createRepo(t);
    writeFileSync(path.join(root, "package.json"), "invalid json");

    assert.throws(() => detectProject(root, []), {
      message: "package.json is not valid JSON.",
    });
  });

  it("detects pnpm via packageManager with corepack, checks order and install", (t) => {
    const root = createRepo(t);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.2.0",
        scripts: {
          build: "tsc",
          unrelated: "echo 1",
          test: "node --test",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          "format:check": "prettier --check .",
        },
      }),
    );

    const info = detectProject(root, []);
    assert.equal(info.packageManager, "pnpm");
    assert.equal(info.corepack, true);
    assert.equal(info.install, "pnpm install");
    assert.deepEqual(info.checks, [
      { script: "format:check", command: "pnpm run format:check" },
      { script: "lint", command: "pnpm run lint" },
      { script: "typecheck", command: "pnpm run typecheck" },
      { script: "test", command: "pnpm test" },
      { script: "build", command: "pnpm run build" },
    ]);
  });

  it("detects npm with package-lock.json using npm ci and test command", (t) => {
    const root = createRepo(t);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node --test",
          lint: "eslint .",
        },
      }),
    );
    writeFileSync(path.join(root, "package-lock.json"), "{}");

    const info = detectProject(root, []);
    assert.equal(info.packageManager, "npm");
    assert.equal(info.corepack, false);
    assert.equal(info.install, "npm ci");
    assert.deepEqual(info.checks, [
      { script: "lint", command: "npm run lint" },
      { script: "test", command: "npm test" },
    ]);
  });

  it("detects npm without package-lock.json using npm install", (t) => {
    const root = createRepo(t);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({}));

    const info = detectProject(root, []);
    assert.equal(info.packageManager, "npm");
    assert.equal(info.corepack, false);
    assert.equal(info.install, "npm install");
  });

  it("detects yarn via yarn.lock and formats checks without run", (t) => {
    const root = createRepo(t);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node --test",
          lint: "eslint .",
        },
      }),
    );
    writeFileSync(path.join(root, "yarn.lock"), "");

    const info = detectProject(root, []);
    assert.equal(info.packageManager, "yarn");
    assert.equal(info.corepack, false);
    assert.equal(info.install, "yarn install");
    assert.deepEqual(info.checks, [
      { script: "lint", command: "yarn lint" },
      { script: "test", command: "yarn test" },
    ]);
  });

  it("detects bun via bun.lock or bun.lockb and uses bun run for test", (t) => {
    const root1 = createRepo(t);
    writeFileSync(
      path.join(root1, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node --test",
          build: "tsc",
        },
      }),
    );
    writeFileSync(path.join(root1, "bun.lock"), "");

    const info1 = detectProject(root1, []);
    assert.equal(info1.packageManager, "bun");
    assert.equal(info1.corepack, false);
    assert.equal(info1.install, "bun install");
    assert.deepEqual(info1.checks, [
      { script: "test", command: "bun run test" },
      { script: "build", command: "bun run build" },
    ]);

    const root2 = createRepo(t);
    writeFileSync(path.join(root2, "package.json"), JSON.stringify({}));
    writeFileSync(path.join(root2, "bun.lockb"), "");

    const info2 = detectProject(root2, []);
    assert.equal(info2.packageManager, "bun");
  });

  it("extracts engines.node", (t) => {
    const root = createRepo(t);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        engines: { node: ">=24" },
      }),
    );

    const info = detectProject(root, []);
    assert.equal(info.nodeVersion, ">=24");

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        engines: { npm: "10" },
      }),
    );
    const infoWithoutNode = detectProject(root, []);
    assert.equal("nodeVersion" in infoWithoutNode, false);
  });

  it("detects AGENTS.md and license files", (t) => {
    const root = createRepo(t);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({}));

    const infoInitial = detectProject(root, []);
    assert.equal(infoInitial.agentsFile, false);
    assert.equal("licenseFile" in infoInitial, false);

    writeFileSync(path.join(root, "AGENTS.md"), "# Agents");
    writeFileSync(path.join(root, "LICENSE.md"), "MIT");

    const infoWithLicenseMd = detectProject(root, []);
    assert.equal(infoWithLicenseMd.agentsFile, true);
    assert.equal(infoWithLicenseMd.licenseFile, "LICENSE.md");
  });

  it("reports the license file as spelled in the root", (t) => {
    for (const name of [
      "LICENSE",
      "LICENSE.md",
      "license",
      "COPYING",
      "LICENSE-MIT",
      "UNLICENSE",
    ]) {
      const root = createRepo(t);
      writeFileSync(path.join(root, name), "text");
      assert.equal(detectProject(root, []).licenseFile, name, name);
    }
  });

  it("does not take other entries for a license file", (t) => {
    const root = createRepo(t);
    writeFileSync(path.join(root, "README.md"), "# Readme");
    mkdirSync(path.join(root, "LICENSES"));

    assert.equal("licenseFile" in detectProject(root, []), false);
  });
});
