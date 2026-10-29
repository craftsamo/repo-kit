import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { commands, main, resolveCommand } from "../src/main.mts";

const cli = new URL("../src/cli.mts", import.meta.url).pathname;
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("resolveCommand", () => {
  it("prefers the longest command name and keeps the rest", () => {
    const one = { summary: "", load: async () => ({ run() {} }) };
    const two = { summary: "", load: async () => ({ run() {} }) };
    commands["example"] = one;
    commands["example nested"] = two;
    try {
      assert.deepEqual(resolveCommand(["example", "nested", "--flag"]), {
        name: "example nested",
        command: two,
        rest: ["--flag"],
      });
      assert.equal(resolveCommand(["example", "--flag"])?.command, one);
      assert.equal(resolveCommand(["missing"]), undefined);
    } finally {
      delete commands["example"];
      delete commands["example nested"];
    }
  });
});

describe("main", () => {
  it("runs a command and turns its errors into exit codes", async () => {
    const { UsageError } = await import("../src/errors.mts");
    const calls = [];
    commands["probe"] = {
      summary: "",
      load: async () => ({
        run(argv) {
          calls.push(argv);
          if (argv[0] === "usage") throw new UsageError("bad usage");
          if (argv[0] === "fail") throw new Error("failed");
        },
      }),
    };
    try {
      assert.equal(await main(["probe", "ok"]), 0);
      assert.equal(await main(["probe", "usage"]), 2);
      assert.equal(await main(["probe", "fail"]), 1);
      assert.deepEqual(calls, [["ok"], ["usage"], ["fail"]]);
    } finally {
      delete commands["probe"];
    }
  });
});

describe("cli", () => {
  it("prints the version and help", () => {
    assert.equal(
      execFileSync(process.execPath, [cli, "--version"], {
        encoding: "utf8",
      }).trim(),
      version,
    );
    assert.match(
      execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }),
      /^Usage: repo-kit <command>/,
    );
  });

  it("exits with 2 for no command or an unknown one", () => {
    assert.equal(spawnSync(process.execPath, [cli]).status, 2);
    const unknown = spawnSync(process.execPath, [cli, "nope"], {
      encoding: "utf8",
    });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown command: nope/);
  });
});
