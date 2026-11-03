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

// The lines of the file indented deeper than the line that opens `block`.
const blockLines = (source, block) => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === block);
  assert.ok(start >= 0, `no ${block.trim()}`);
  const indent = lines[start].search(/\S/);
  const inside = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    inside.push(line);
  }
  return inside.join("\n");
};

describe("release-publish.yml inputs and outputs", () => {
  const source = reusable.find(
    ({ file }) => file === "release-publish.yml",
  ).source;
  const body = code(source);

  it("takes the version files, the build and its artifacts as optional strings", () => {
    const inputs = blockLines(body, "    inputs:");
    for (const name of ["version-files", "build-command", "artifacts"]) {
      const input = blockLines(inputs, `      ${name}:`);
      assert.match(input, /type: string/, name);
      assert.match(input, /default: ""/, name);
    }
    const pnpm = blockLines(inputs, "      setup-pnpm:");
    assert.match(pnpm, /type: boolean/);
    assert.match(pnpm, /default: false/);
    const nodeVersionFile = blockLines(inputs, "      node-version-file:");
    assert.match(nodeVersionFile, /type: string/);
    assert.match(nodeVersionFile, /default: ""/);
  });

  it("hands the published tag to the caller", () => {
    const tag = blockLines(blockLines(body, "    outputs:"), "      tag:");
    assert.match(tag, /value: \$\{\{ jobs\.publish\.outputs\.tag \}\}/);
    const job = blockLines(body, "  publish:");
    assert.match(
      blockLines(job, "    outputs:"),
      /tag: \$\{\{ steps\.release\.outputs\.tag \}\}/,
    );
    assert.match(job, /- name: Run the release step\n\s+id: release\n/);
  });

  it("passes the inputs to the command line through the environment", () => {
    const step = blockLines(body, "      - name: Run the release step");
    const script = blockLines(step, "        run: |");
    assert.doesNotMatch(script, /\$\{\{/);
    for (const [name, input] of [
      ["VERSION_FILES", "version-files"],
      ["BUILD_COMMAND", "build-command"],
      ["ARTIFACTS", "artifacts"],
    ]) {
      assert.match(
        step,
        new RegExp(`${name}: \\$\\{\\{ inputs\\.${input} \\}\\}`),
      );
    }
    for (const flag of ["--version-file", "--build-command", "--artifact"]) {
      assert.ok(script.includes(flag), flag);
    }
  });

  it("builds only for a release published from the Actions tab", () => {
    const script = blockLines(
      blockLines(body, "      - name: Run the release step"),
      "        run: |",
    );
    const [sync, publish] = script.split("\n          else\n");
    assert.match(sync, /release sync --tag/);
    assert.doesNotMatch(sync, /--build-command|--artifact/);
    assert.match(publish, /release publish/);
    assert.match(publish, /--build-command/);
  });
});
