import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  fetchLicense,
  findExisting,
  parseCommunityArguments,
  planCommunityFiles,
  writeCommunityFiles,
} from "../../src/community/setup.mts";
import { UsageError } from "../../src/errors.mts";
import { CommandError } from "../../src/github/gh.mts";

const httpError = (status, message) =>
  new CommandError("gh api", { stderr: `gh: ${message} (HTTP ${status})` });

function repository(t) {
  const root = mkdtempSync(path.join(tmpdir(), "setup-community-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(root, file, content = "") {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const ISSUE_FORM = ".github/ISSUE_TEMPLATE/bug_report.yml";

describe("parseCommunityArguments", () => {
  it("defaults to writing after a question, without a license", () => {
    assert.deepEqual(parseCommunityArguments([]), {
      dryRun: false,
      yes: false,
    });
  });

  it("takes the flags and lower-cases the license id", () => {
    assert.deepEqual(
      parseCommunityArguments(["--license", "MIT", "--dry-run", "--yes"]),
      { license: "mit", dryRun: true, yes: true },
    );
  });

  it("reports a wrong argument as a usage error", () => {
    assert.throws(() => parseCommunityArguments(["mit"]), UsageError);
    assert.throws(() => parseCommunityArguments(["--force"]), UsageError);
    assert.throws(
      () => parseCommunityArguments(["--license"]),
      /--license requires a value/,
    );
    assert.throws(
      () => parseCommunityArguments(["--license", "--yes"]),
      UsageError,
    );
  });
});

describe("findExisting", () => {
  it("finds nothing in an empty repository", (t) => {
    const root = repository(t);
    for (const file of [
      "CONTRIBUTING.md",
      "SECURITY.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ISSUE_FORM,
      "LICENSE",
    ]) {
      assert.equal(findExisting(root, file), undefined, file);
    }
  });

  it("finds a contributing guide in the root, .github or docs by any spelling", (t) => {
    const root = repository(t);
    touch(root, "docs/Contributing.md");
    assert.equal(findExisting(root, "CONTRIBUTING.md"), "docs/Contributing.md");

    touch(root, ".github/CONTRIBUTING.rst");
    assert.equal(
      findExisting(root, "CONTRIBUTING.md"),
      ".github/CONTRIBUTING.rst",
    );

    touch(root, "contributing");
    assert.equal(findExisting(root, "CONTRIBUTING.md"), "contributing");
  });

  it("finds a security policy by any spelling", (t) => {
    const root = repository(t);
    touch(root, ".github/security.MD");
    assert.equal(findExisting(root, "SECURITY.md"), ".github/security.MD");
    assert.equal(findExisting(root, "CONTRIBUTING.md"), undefined);
  });

  it("does not take a similarly named file for a guide", (t) => {
    const root = repository(t);
    touch(root, "CONTRIBUTING-GUIDE.md");
    touch(root, "securityreport.md");
    assert.equal(findExisting(root, "CONTRIBUTING.md"), undefined);
    assert.equal(findExisting(root, "SECURITY.md"), undefined);
  });

  it("finds a pull request template file or directory", (t) => {
    const root = repository(t);
    const template = ".github/PULL_REQUEST_TEMPLATE.md";
    touch(root, ".github/pull_request_template.md");
    assert.equal(
      findExisting(root, template),
      ".github/pull_request_template.md",
    );

    const other = repository(t);
    touch(other, "docs/PULL_REQUEST_TEMPLATE/feature.md");
    assert.equal(findExisting(other, template), "docs/PULL_REQUEST_TEMPLATE");

    const bare = repository(t);
    touch(bare, "pull_request_template");
    assert.equal(findExisting(bare, template), undefined);
  });

  it("treats the issue forms as one set, found by a non-empty directory", (t) => {
    const root = repository(t);
    mkdirSync(path.join(root, ".github/issue_template"), { recursive: true });
    assert.equal(findExisting(root, ISSUE_FORM), undefined);

    touch(root, ".github/issue_template/custom.yml");
    for (const form of [
      ISSUE_FORM,
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
    ]) {
      assert.equal(findExisting(root, form), ".github/issue_template", form);
    }
  });

  it("finds a legacy single issue template", (t) => {
    const root = repository(t);
    touch(root, "ISSUE_TEMPLATE.md");
    assert.equal(findExisting(root, ISSUE_FORM), "ISSUE_TEMPLATE.md");
  });

  it("finds a license file by either spelling and any extension", (t) => {
    const root = repository(t);
    touch(root, "package.json");
    assert.equal(findExisting(root, "LICENSE"), undefined);

    touch(root, "LICENSE.txt");
    assert.equal(findExisting(root, "LICENSE"), "LICENSE.txt");

    const british = repository(t);
    touch(british, "Licence");
    assert.equal(findExisting(british, "LICENSE"), "Licence");

    const copying = repository(t);
    touch(copying, "COPYING");
    assert.equal(findExisting(copying, "LICENSE"), "COPYING");
  });

  it("finds a file at the exact path of any other output", (t) => {
    const root = repository(t);
    touch(root, "NOTES.md");
    assert.equal(findExisting(root, "NOTES.md"), "NOTES.md");
    assert.equal(findExisting(root, "OTHER.md"), undefined);
  });
});

describe("planCommunityFiles", () => {
  it("splits the files into those to write and those left as they are", (t) => {
    const root = repository(t);
    touch(root, "docs/contributing.md");
    touch(root, ".github/ISSUE_TEMPLATE/bug.yml");
    const files = [
      { path: "CONTRIBUTING.md", content: "a" },
      { path: "SECURITY.md", content: "b" },
      { path: ISSUE_FORM, content: "c" },
      { path: ".github/ISSUE_TEMPLATE/config.yml", content: "d" },
    ];

    assert.deepEqual(planCommunityFiles(root, files), {
      write: [files[1]],
      skip: [
        { path: "CONTRIBUTING.md", existing: "docs/contributing.md" },
        { path: ISSUE_FORM, existing: ".github/ISSUE_TEMPLATE" },
        {
          path: ".github/ISSUE_TEMPLATE/config.yml",
          existing: ".github/ISSUE_TEMPLATE",
        },
      ],
    });
  });
});

describe("fetchLicense", () => {
  const body =
    "Copyright (c) [year] [fullname]\n\n[yyyy] [name of copyright owner]\n";

  function fakeRequest({ name = "Jane Doe", failLicense } = {}) {
    const calls = [];
    const request = (method, endpoint) => {
      calls.push(`${method} ${endpoint}`);
      if (endpoint.startsWith("/licenses/")) {
        if (failLicense) throw failLicense;
        return { body };
      }
      return { name };
    };
    return { request, calls };
  }

  it("fills in the year and the owner's display name", () => {
    const { request, calls } = fakeRequest();

    assert.deepEqual(fetchLicense("mit", "jane", request, 2026), {
      path: "LICENSE",
      content:
        "Copyright (c) 2026 Jane Doe\n\n[yyyy] [name of copyright owner]\n",
    });
    assert.deepEqual(calls, ["GET /licenses/mit", "GET /users/jane"]);
  });

  it("falls back to the login when the owner has no name", () => {
    for (const name of [null, "", "  "]) {
      const { request } = fakeRequest({ name });
      assert.match(
        fetchLicense("mit", "craftsamo", request, 2026).content,
        /^Copyright \(c\) 2026 craftsamo\n/,
      );
    }
  });

  it("keeps a name with replacement patterns as it is", () => {
    const { request } = fakeRequest({ name: "Acme $& Co" });
    assert.match(
      fetchLicense("mit", "acme", request, 2026).content,
      /^Copyright \(c\) 2026 Acme \$& Co\n/,
    );
  });

  it("reports an unknown license as a usage error", () => {
    const { request } = fakeRequest({
      failLicense: httpError(404, "Not Found"),
    });

    assert.throws(
      () => fetchLicense("nope", "jane", request),
      (error) =>
        error instanceof UsageError &&
        error.message ===
          "Unknown license: nope. `gh repo license list` shows the ids.",
    );
  });

  it("rethrows any other error", () => {
    const failure = httpError(500, "Server Error");
    const { request } = fakeRequest({ failLicense: failure });

    assert.throws(() => fetchLicense("mit", "jane", request), failure);
  });
});

describe("writeCommunityFiles", () => {
  it("creates the directories of each file", (t) => {
    const root = repository(t);
    writeCommunityFiles(root, [
      { path: "SECURITY.md", content: "policy\n" },
      { path: ISSUE_FORM, content: "form\n" },
    ]);

    assert.equal(
      readFileSync(path.join(root, "SECURITY.md"), "utf8"),
      "policy\n",
    );
    assert.equal(readFileSync(path.join(root, ISSUE_FORM), "utf8"), "form\n");
  });

  it("never overwrites a file that appeared since planning", (t) => {
    const root = repository(t);
    touch(root, "SECURITY.md", "mine\n");

    assert.throws(
      () =>
        writeCommunityFiles(root, [{ path: "SECURITY.md", content: "new\n" }]),
      (error) =>
        /^Could not write SECURITY\.md: .*Nothing was written\.$/.test(
          error.message,
        ) && error.cause.code === "EEXIST",
    );
    assert.equal(
      readFileSync(path.join(root, "SECURITY.md"), "utf8"),
      "mine\n",
    );
    assert.equal(existsSync(path.join(root, ".github")), false);
  });

  it("refuses a directory that is a link to outside the repository", (t) => {
    const root = repository(t);
    const outside = repository(t);
    symlinkSync(outside, path.join(root, ".github"), "dir");

    assert.throws(
      () =>
        writeCommunityFiles(root, [
          { path: "CONTRIBUTING.md", content: "guide\n" },
          { path: ".github/PULL_REQUEST_TEMPLATE.md", content: "template\n" },
        ]),
      (error) =>
        /^Could not write \.github\/PULL_REQUEST_TEMPLATE\.md: .*resolves outside the repository.*Already written: CONTRIBUTING\.md\.$/.test(
          error.message,
        ),
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(
      readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8"),
      "guide\n",
    );
  });

  it("creates no directory outside the repository for a nested path", (t) => {
    const root = repository(t);
    const outside = repository(t);
    symlinkSync(outside, path.join(root, ".github"), "dir");

    assert.throws(
      () =>
        writeCommunityFiles(root, [{ path: ISSUE_FORM, content: "form\n" }]),
      /resolves outside the repository.*Nothing was written\.$/,
    );
    assert.deepEqual(readdirSync(outside), []);
  });

  it("names the files already written when a later write fails", (t) => {
    const root = repository(t);
    touch(root, ".github/ISSUE_TEMPLATE", "not a directory\n");

    assert.throws(
      () =>
        writeCommunityFiles(root, [
          { path: "CONTRIBUTING.md", content: "guide\n" },
          { path: ISSUE_FORM, content: "form\n" },
        ]),
      (error) =>
        error.message.startsWith(`Could not write ${ISSUE_FORM}: `) &&
        error.message.endsWith("Already written: CONTRIBUTING.md.") &&
        error.cause instanceof Error,
    );
    assert.equal(
      readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8"),
      "guide\n",
    );
  });
});
