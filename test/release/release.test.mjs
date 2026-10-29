import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bumpedManifest,
  bumpMessage,
  currentVersion,
  draftVersion,
  isLowerVersion,
  parseDraftArguments,
  parsePublishArguments,
  parseSyncArguments,
  unlistedCommits,
} from "../../src/release/release.mts";
import { UsageError } from "../../src/errors.mts";

const release = (tag_name, draft) => ({
  id: 1,
  draft,
  tag_name,
  name: `${tag_name} 🚀`,
  html_url: `https://example.test/releases/${tag_name}`,
});

describe("draftVersion", () => {
  it("takes the version from the one draft's tag", () => {
    const releases = [release("v0.10.0", false), release("v0.11.0", true)];
    assert.deepEqual(draftVersion(releases, "v"), {
      version: "0.11.0",
      draft: releases[1],
    });
  });

  it("keeps a prerelease suffix", () => {
    assert.equal(
      draftVersion([release("v1.0.0-rc.1", true)], "v").version,
      "1.0.0-rc.1",
    );
  });

  it("strips the configured tag prefix", () => {
    assert.equal(
      draftVersion([release("release-2.0.0", true)], "release-").version,
      "2.0.0",
    );
    assert.equal(draftVersion([release("2.0.0", true)], "").version, "2.0.0");
  });

  it("refuses no draft, several drafts, or a tag of another shape", () => {
    const releases = (...tags) => tags.map((tag) => release(tag, true));
    assert.throws(
      () => draftVersion([release("v0.10.0", false)], "v"),
      /No draft/,
    );
    assert.throws(
      () => draftVersion(releases("v0.11.0", "v0.12.0"), "v"),
      /Several draft releases \(v0\.11\.0, v0\.12\.0\)/,
    );
    assert.throws(() => draftVersion(releases("0.11.0"), "v"), /not v</);
    assert.throws(() => draftVersion(releases("v0.11"), "v"), /not v</);
  });
});

describe("bumpedManifest", () => {
  const manifest = [
    "{",
    '  "name": "turborepo-starter",',
    '  "version": "0.0.0",',
    '  "private": true,',
    '  "scripts": {',
    '    "version": "echo not this one"',
    "  }",
    "}",
    "",
  ].join("\n");

  it("rewrites the top-level version and nothing else", () => {
    const bumped = bumpedManifest(manifest, "0.11.0");
    assert.equal(bumped, manifest.replace('"0.0.0"', '"0.11.0"'));
    assert.equal(currentVersion(bumped), "0.11.0");
    assert.match(bumped, /"version": "echo not this one"/);
  });

  it("refuses a manifest without a top-level version", () => {
    assert.throws(
      () => bumpedManifest('{\n  "name": "x"\n}\n', "1.0.0"),
      /no top-level version field/,
    );
    assert.throws(
      () =>
        bumpedManifest(
          '{\n  "scripts": {\n    "version": "x"\n  }\n}\n',
          "1.0.0",
        ),
      /no top-level version field/,
    );
  });
});

describe("bumpMessage", () => {
  // The commit is made with hooks off, so these stand in for the commitlint
  // rules in commitlint.config.js that the message could break.
  it("keeps to the commit convention, even for a long prerelease", () => {
    for (const version of ["0.11.0", "10.20.30-beta.12"]) {
      const [subject, body] = bumpMessage(version, "v");
      const header = /^chore\(release\): (.+)$/.exec(subject);
      assert.ok(header, subject);
      assert.ok(header[1].length <= 50, `subject too long: ${header[1]}`);
      assert.doesNotMatch(header[1], /^[A-Z]|\.$/);
      assert.match(body, new RegExp(`v${version.replaceAll(".", "\\.")}`));
      for (const line of body.split("\n")) {
        assert.ok(line.length <= 72, `body line too long: ${line}`);
      }
    }
  });
});

describe("parseDraftArguments", () => {
  it("takes a target commit and a dry run", () => {
    assert.deepEqual(parseDraftArguments([]), { dryRun: false });
    assert.deepEqual(
      parseDraftArguments(["--target", "52bf51f", "--dry-run"]),
      {
        target: "52bf51f",
        dryRun: true,
      },
    );
  });

  it("rejects a target that is not a commit SHA, or another flag", () => {
    assert.throws(() => parseDraftArguments(["--target"]), /--target/);
    assert.throws(() => parseDraftArguments(["--target", "main"]), /--target/);
    assert.throws(() => parseDraftArguments(["--force"]), /Unknown argument/);
    assert.throws(() => parseDraftArguments(["--force"]), UsageError);
  });
});

describe("parseSyncArguments", () => {
  it("takes a version or nothing", () => {
    assert.deepEqual(parseSyncArguments([]), {});
    assert.deepEqual(parseSyncArguments(["--version", "0.11.0"]), {
      version: "0.11.0",
    });
    assert.deepEqual(parseSyncArguments(["--version", "1.0.0-rc.1"]), {
      version: "1.0.0-rc.1",
    });
  });

  it("rejects a missing or malformed version, or another flag", () => {
    assert.throws(() => parseSyncArguments(["--version"]), /--version/);
    assert.throws(
      () => parseSyncArguments(["--version", "v0.11.0"]),
      /--version/,
    );
    assert.throws(() => parseSyncArguments(["--force"]), /Unknown argument/);
  });

  it("takes the tag of a published release instead of a version", () => {
    assert.deepEqual(parseSyncArguments(["--tag", "v0.11.0"]), {
      tag: "v0.11.0",
    });
    assert.throws(() => parseSyncArguments(["--tag"]), /--tag requires/);
    assert.throws(
      () => parseSyncArguments(["--tag", "v1.0.0", "--version", "1.0.0"]),
      /either --version or --tag/,
    );
  });
});

describe("parsePublishArguments", () => {
  it("takes a dry run and nothing else", () => {
    assert.deepEqual(parsePublishArguments([]), { dryRun: false });
    assert.deepEqual(parsePublishArguments(["--dry-run"]), { dryRun: true });
    assert.throws(() => parsePublishArguments(["--force"]), /Unknown argument/);
  });
});

describe("unlistedCommits", () => {
  it("keeps every commit except the version bumps", () => {
    const [bump] = bumpMessage("0.12.0", "v");
    const log = [
      `${"a".repeat(40)} ${bump}`,
      `${"b".repeat(40)} Add a page (#64)`,
      `${"c".repeat(40)} chore(release): something else`,
      "",
    ].join("\n");
    assert.deepEqual(unlistedCommits(log), [
      `${"b".repeat(40)} Add a page (#64)`,
      `${"c".repeat(40)} chore(release): something else`,
    ]);
    assert.deepEqual(unlistedCommits(`${"a".repeat(40)} ${bump}`), []);
    assert.deepEqual(unlistedCommits(""), []);
  });
});

describe("isLowerVersion", () => {
  it("orders versions, a prerelease before its release", () => {
    assert.equal(isLowerVersion("0.11.0", "0.12.0"), true);
    assert.equal(isLowerVersion("0.12.0", "0.11.9"), false);
    assert.equal(isLowerVersion("0.9.0", "0.10.0"), true);
    assert.equal(isLowerVersion("1.0.0", "1.0.0"), false);
    assert.equal(isLowerVersion("1.0.0-rc.1", "1.0.0"), true);
    assert.equal(isLowerVersion("1.0.0", "1.0.0-rc.1"), false);
    assert.equal(isLowerVersion("1.0.0-rc.2", "1.0.0-rc.10"), true);
    assert.equal(isLowerVersion("1.0.0-beta", "1.0.0-rc"), true);
    assert.equal(isLowerVersion("1.0.0-rc", "1.0.0-rc.1"), true);
  });
});
