import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { assetPath } from "../../src/package-root.mts";
import {
  escapeTitle,
  nextVersion,
  parseNotesConfig,
  pullRequestsInRange,
  releaseChanges,
  renderNotes,
  versionOfTag,
} from "../../src/release/notes.mts";

// A config with categories by label, as a repository with its own
// .github/release-notes.json has.
const config = parseNotesConfig(
  readFileSync(
    path.join(import.meta.dirname, "fixtures/release-notes.json"),
    "utf8",
  ),
);
const shipped = parseNotesConfig(
  readFileSync(assetPath("release", "release-notes.json"), "utf8"),
);

let next = 1;
const pr = (labels, fields = {}) => {
  const number = next++;
  return {
    number,
    title: `Change ${number}`,
    author: "octocat",
    labels,
    mergedAt: `2026-10-${String(10 + number).padStart(2, "0")}T00:00:00Z`,
    mergeCommit: `c${number}`,
    ...fields,
  };
};

describe("parseNotesConfig", () => {
  it("reads a repository's configuration", () => {
    assert.equal(config.tagPrefix, "v");
    assert.deepEqual(config.exclude, ["skip-changelog"]);
    assert.equal(config.categories.at(-1).labels, undefined);
  });

  it("ships a default that lists every pull request as a patch", () => {
    const changes = releaseChanges([pr(["anything"]), pr([])], shipped);

    assert.equal(shipped.tagPrefix, "v");
    assert.deepEqual(
      changes.sections.map((section) => section.title),
      ["Changes"],
    );
    assert.equal(changes.sections[0].pullRequests.length, 2);
    assert.equal(changes.increment, "patch");
    assert.equal(releaseChanges([pr(["skip-changelog"])], shipped), undefined);
  });

  it("refuses a name without the version, or two catch-all categories", () => {
    const base = { name: "v{version}", tagPrefix: "v", titleEscapes: "" };
    assert.throws(
      () =>
        parseNotesConfig(
          JSON.stringify({
            ...base,
            name: "release",
            categories: [{ title: "A" }],
          }),
        ),
      /name must contain \{version\}/,
    );
    assert.throws(
      () =>
        parseNotesConfig(
          JSON.stringify({
            ...base,
            categories: [{ title: "A" }, { title: "B" }],
          }),
        ),
      /Only one category may omit labels/,
    );
    assert.throws(
      () =>
        parseNotesConfig(
          JSON.stringify({
            ...base,
            categories: [{ title: "A", labels: ["a"], increment: "major" }],
          }),
        ),
      /increment must be/,
    );
  });
});

describe("pullRequestsInRange", () => {
  it("keeps the pull requests merged into the range, whatever their base", () => {
    // A stack merged in one go: every layer records the same merge commit,
    // though only the lowest one targeted main.
    const stack = [pr([]), pr([]), pr([])].map((p) => ({
      ...p,
      mergeCommit: "stack",
      mergedAt: "2026-10-28T13:25:08Z",
    }));
    const elsewhere = pr([], { mergeCommit: "other-branch" });
    const kept = pullRequestsInRange(
      [...stack, elsewhere, stack[0]],
      new Set(["stack", "unrelated"]),
    );
    assert.deepEqual(
      kept.map(({ number }) => number),
      stack.map(({ number }) => number).reverse(),
    );
  });

  it("orders the newest merge first", () => {
    const older = pr([], { mergedAt: "2026-10-01T00:00:00Z" });
    const newer = pr([], { mergedAt: "2026-10-02T00:00:00Z" });
    const kept = pullRequestsInRange(
      [older, newer],
      new Set([older.mergeCommit, newer.mergeCommit]),
    );
    assert.deepEqual(kept, [newer, older]);
  });
});

describe("releaseChanges", () => {
  it("lists each pull request once, under its first matching category", () => {
    const both = pr(["⚒️enhancement", "🌱feature"]);
    const bug = pr(["🐛bug"]);
    const plain = pr([]);
    const changes = releaseChanges([both, bug, plain], config);
    assert.deepEqual(
      changes.sections.map(({ title, pullRequests }) => [
        title,
        pullRequests.map(({ number }) => number),
      ]),
      [
        ["🚀 New Features", [both.number]],
        ["🐛 Bug Fixes", [bug.number]],
        ["🧰 Other Changes", [plain.number]],
      ],
    );
  });

  it("files upkeep by its type label and ignores area labels", () => {
    const ci = pr(["🔧maintenance", "🔄workflows"]);
    const bump = pr(["dependencies"]);
    const areaOnly = pr(["🌐app: web", "📦package: ui"]);
    const changes = releaseChanges([ci, bump, areaOnly], config);
    assert.deepEqual(
      changes.sections.map(({ title, pullRequests }) => [
        title,
        pullRequests.map(({ number }) => number),
      ]),
      [
        ["⬆️ Dependencies", [bump.number]],
        ["🔧 Maintenance", [ci.number]],
        ["🧰 Other Changes", [areaOnly.number]],
      ],
    );
    assert.equal(changes.increment, "patch");
  });

  it("raises the version by the highest increment, major above all", () => {
    assert.equal(
      releaseChanges([pr(["🐛bug"]), pr([])], config).increment,
      "patch",
    );
    assert.equal(
      releaseChanges([pr(["🐛bug"]), pr(["🌱feature"])], config).increment,
      "minor",
    );
    assert.equal(
      releaseChanges([pr(["📝documentation", "🌟major"])], config).increment,
      "major",
    );
  });

  it("leaves excluded pull requests out of the notes and the version", () => {
    const changes = releaseChanges(
      [pr(["🌱feature", "skip-changelog"]), pr(["🐛bug"])],
      config,
    );
    assert.equal(changes.increment, "patch");
    assert.equal(changes.sections.length, 1);
    assert.equal(releaseChanges([pr(["skip-changelog"])], config), undefined);
    assert.equal(releaseChanges([], config), undefined);
  });
});

describe("versions", () => {
  it("raises a version by an increment", () => {
    assert.equal(nextVersion("0.10.0", "patch"), "0.10.1");
    assert.equal(nextVersion("0.10.1", "minor"), "0.11.0");
    assert.equal(nextVersion("0.10.1", "major"), "1.0.0");
    assert.equal(nextVersion("0.0.0", "minor"), "0.1.0");
    assert.throws(
      () => nextVersion("v1.0.0", "patch"),
      /not a semantic version/,
    );
  });

  it("reads the version of a release tag", () => {
    assert.equal(versionOfTag("v0.10.0", config), "0.10.0");
    assert.equal(versionOfTag("v1.0.0-rc.1", config), "1.0.0-rc.1");
    assert.equal(versionOfTag("0.10.0", config), undefined);
    assert.equal(versionOfTag("vnext", config), undefined);
  });
});

describe("renderNotes", () => {
  it("escapes Markdown in titles except inside code spans", () => {
    assert.equal(
      escapeTitle("Use <b> and `a_b*c` with x_y", "\\<*_&"),
      "Use \\<b> and `a_b*c` with x\\_y",
    );
  });

  it("renders each section with its pull requests", () => {
    const feature = pr(["🌱feature"], { title: "Add a thing", author: "a" });
    const fix = pr(["🐛bug"], { title: "Fix a_thing", author: "b" });
    const { sections } = releaseChanges([feature, fix], config);
    assert.equal(
      renderNotes(sections, config),
      [
        "## 🚀 New Features",
        "",
        `- Add a thing @a (#${feature.number})`,
        "",
        "## 🐛 Bug Fixes",
        "",
        `- Fix a\\_thing @b (#${fix.number})`,
        "",
      ].join("\n"),
    );
  });
});
