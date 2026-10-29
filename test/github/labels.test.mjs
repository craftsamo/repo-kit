import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  applyLabels,
  diffLabels,
  getCurrentLabels,
  parseLabels,
  readLabels,
} from "../../src/github/labels.mts";

const source = `
- name: "feature"
  description: "Feature addition"
  color: "0E8A16"
- name: 'question'
  description: 'General inquiries'
  color: 'D876E3'
`;

function repository(t) {
  const root = mkdtempSync(path.join(tmpdir(), "labels-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("parseLabels", () => {
  it("parses the supported labels manifest", () => {
    assert.deepEqual(parseLabels(source), [
      {
        name: "feature",
        description: "Feature addition",
        color: "0E8A16",
      },
      {
        name: "question",
        description: "General inquiries",
        color: "D876E3",
      },
    ]);
  });

  it("fails closed for incomplete label definitions", () => {
    assert.throws(
      () => parseLabels('- name: "feature"\n  color: "0E8A16"\n'),
      /Incomplete label definition/,
    );
  });

  it("fails closed for a manifest without labels", () => {
    assert.throws(() => parseLabels("# none\n"), /No labels found/);
  });
});

describe("readLabels", () => {
  it("reads the repository's manifest", (t) => {
    const root = repository(t);
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github/labels.yml"), source);

    assert.equal(readLabels(root)?.length, 2);
  });

  it("returns nothing for a repository without one", (t) => {
    assert.equal(readLabels(repository(t)), undefined);
  });
});

describe("diffLabels", () => {
  it("computes create, update, and delete operations", () => {
    const desired = parseLabels(source);
    const changes = diffLabels(desired, [
      { name: "feature", description: "Old", color: "ffffff" },
      { name: "obsolete", description: "Remove", color: "000000" },
    ]);

    assert.deepEqual(
      changes.create.map((label) => label.name),
      ["question"],
    );
    assert.deepEqual(
      changes.update.map(({ desired: label }) => label.name),
      ["feature"],
    );
    assert.deepEqual(
      changes.remove.map((label) => label.name),
      ["obsolete"],
    );
  });

  it("updates labels whose GitHub description is null", () => {
    const desired = [
      { name: "feature", description: "Feature addition", color: "0E8A16" },
    ];
    const changes = diffLabels(desired, [
      { name: "feature", description: null, color: "0E8A16" },
    ]);

    assert.equal(changes.update.length, 1);
    assert.equal(changes.update[0].desired.description, "Feature addition");
  });

  it("renames a label whose name only changes case", () => {
    const changes = diffLabels(
      [{ name: "Bug", description: "Bugs", color: "D73A4A" }],
      [{ name: "bug", description: "Bugs", color: "D73A4A" }],
    );

    assert.equal(changes.create.length, 0);
    assert.equal(changes.remove.length, 0);
    assert.deepEqual(
      changes.update.map(({ current, desired }) => [
        current.name,
        desired.name,
      ]),
      [["bug", "Bug"]],
    );
  });
});

describe("getCurrentLabels", () => {
  it("reads every page until a short one", () => {
    const label = (n) => ({ name: `l${n}`, description: null, color: "000" });
    const pages = [
      Array.from({ length: 100 }, (_, n) => label(n)),
      [label(100), label(101)],
    ];
    const endpoints = [];
    const request = (method, endpoint) => {
      endpoints.push(endpoint);
      return pages[endpoints.length - 1];
    };

    assert.equal(getCurrentLabels("owner/repo", request).length, 102);
    assert.deepEqual(endpoints, [
      "/repos/owner/repo/labels?per_page=100&page=1",
      "/repos/owner/repo/labels?per_page=100&page=2",
    ]);
  });
});

describe("applyLabels", () => {
  it("creates, renames and deletes with escaped names", () => {
    const calls = [];
    applyLabels(
      "owner/repo",
      {
        create: [{ name: "new", description: "", color: "fff" }],
        update: [
          {
            current: { name: "a/b", description: null, color: "000" },
            desired: { name: "a-b", description: "d", color: "111" },
          },
        ],
        remove: [{ name: "old one", description: null, color: "000" }],
      },
      (method, endpoint, body) => calls.push([method, endpoint, body]),
    );

    assert.deepEqual(calls, [
      [
        "POST",
        "/repos/owner/repo/labels",
        { name: "new", description: "", color: "fff" },
      ],
      [
        "PATCH",
        "/repos/owner/repo/labels/a%2Fb",
        { new_name: "a-b", color: "111", description: "d" },
      ],
      ["DELETE", "/repos/owner/repo/labels/old%20one", undefined],
    ]);
  });
});
