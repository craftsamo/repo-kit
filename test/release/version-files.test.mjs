import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bumpedVersionFile,
  versionFileFormat,
} from "../../src/release/version-files.mts";

describe("versionFileFormat", () => {
  it("knows JSON and YAML files by their extension", () => {
    assert.equal(versionFileFormat("app/package.json"), "json");
    assert.equal(versionFileFormat("chart/Chart.yaml"), "yaml");
    assert.equal(versionFileFormat("chart/Chart.YML"), "yaml");
    assert.equal(versionFileFormat("VERSION"), undefined);
    assert.equal(versionFileFormat("pyproject.toml"), undefined);
  });
});

describe("bumpedVersionFile (JSON)", () => {
  const manifest = [
    "{",
    '  "name": "app",',
    '  "dependencies": { "version": "1.0.0" },',
    '  "version": "0.0.0",',
    '  "scripts": {',
    '    "version": "echo not this one"',
    "  },",
    '  "list": [{ "version": "9.9.9" }]',
    "}",
    "",
  ].join("\n");

  it("rewrites the top-level version and nothing else", () => {
    const bumped = bumpedVersionFile("a.json", manifest, "1.2.3");
    assert.equal(bumped, manifest.replace('"0.0.0"', '"1.2.3"'));
  });

  it("leaves nested version keys alone, even before the top-level one", () => {
    const nested = '{"a":{"version":"1.0.0"},"version":"2.0.0"}';
    assert.equal(
      bumpedVersionFile("a.json", nested, "3.0.0"),
      '{"a":{"version":"1.0.0"},"version":"3.0.0"}',
    );
  });

  it("keeps the indentation, the line endings and the final newline", () => {
    for (const source of [
      '{\n\t"version" : "0.0.0",\n\t"name": "x"\n}\n',
      '{\r\n    "version": "0.0.0"\r\n}\r\n',
      '{"name":"x","version":"0.0.0"}',
    ]) {
      assert.equal(
        bumpedVersionFile("a.json", source, "0.1.0"),
        source.replace("0.0.0", "0.1.0"),
      );
    }
  });

  it("is not fooled by version inside a string value or an escape", () => {
    const source = '{"note":"\\"version\\": \\"1.0.0\\"","version":"0.0.0"}';
    assert.equal(
      bumpedVersionFile("a.json", source, "0.1.0"),
      source.replace('"version":"0.0.0"', '"version":"0.1.0"'),
    );
  });

  it("refuses a file without a top-level version string", () => {
    const refuse = (source) =>
      assert.throws(
        () => bumpedVersionFile("a.json", source, "1.0.0"),
        /a\.json has no top-level version field/,
      );
    refuse('{\n  "name": "x"\n}\n');
    refuse('{\n  "scripts": {\n    "version": "x"\n  }\n}\n');
    refuse('{ "version": 1 }');
    refuse('[{ "version": "1.0.0" }]');
    refuse('{ "a": "version" }');
    refuse("");
  });
});

describe("bumpedVersionFile (YAML)", () => {
  it("rewrites the top-level version and nothing else", () => {
    const chart = [
      "apiVersion: v2",
      "name: chart",
      "version: 0.1.0",
      'appVersion: "1.16.0"',
      "",
    ].join("\n");
    assert.equal(
      bumpedVersionFile("Chart.yaml", chart, "1.2.3"),
      chart.replace("version: 0.1.0", "version: 1.2.3"),
    );
  });

  it("leaves indented version keys alone, even before the top-level one", () => {
    const source = ["image:", "  version: 9.9.9", "version: 0.1.0", ""].join(
      "\n",
    );
    assert.equal(
      bumpedVersionFile("a.yml", source, "1.0.0"),
      source.replace("version: 0.1.0", "version: 1.0.0"),
    );
  });

  it("keeps quotes, comments and line endings", () => {
    for (const [source, expected] of [
      ['version: "0.1.0"\n', 'version: "1.0.0"\n'],
      ["version: '0.1.0' # the chart\n", "version: '1.0.0' # the chart\n"],
      [
        "version:   0.1.0   # note\r\nname: x\r\n",
        "version:   1.0.0   # note\r\nname: x\r\n",
      ],
      ["name: x\nversion: 0.1.0", "name: x\nversion: 1.0.0"],
    ]) {
      assert.equal(bumpedVersionFile("a.yaml", source, "1.0.0"), expected);
    }
  });

  it("rewrites the first document of a stream and leaves the rest alone", () => {
    const later = "---\nversion: 9.9.9\nname: second\n";
    for (const [source, expected] of [
      [
        `name: first\nversion: 0.1.0\n${later}`,
        `name: first\nversion: 1.0.0\n${later}`,
      ],
      [
        `---\nname: first\nversion: 0.1.0\n${later}`,
        `---\nname: first\nversion: 1.0.0\n${later}`,
      ],
      [
        `# chart\n%YAML 1.2\n--- # first\nversion: 0.1.0\n${later}`,
        `# chart\n%YAML 1.2\n--- # first\nversion: 1.0.0\n${later}`,
      ],
      [
        `---\r\nversion: 0.1.0\r\n---\r\nversion: 9.9.9\r\n`,
        `---\r\nversion: 1.0.0\r\n---\r\nversion: 9.9.9\r\n`,
      ],
    ]) {
      assert.equal(bumpedVersionFile("a.yaml", source, "1.0.0"), expected);
    }
  });

  it("refuses a stream whose first document has no version", () => {
    for (const source of [
      "name: first\n---\nversion: 0.1.0\n",
      "---\nname: first\n---\nversion: 0.1.0\n",
      "---\n---\nversion: 0.1.0\n",
    ]) {
      assert.throws(
        () => bumpedVersionFile("a.yaml", source, "1.0.0"),
        /a\.yaml has no top-level version field/,
        JSON.stringify(source),
      );
    }
  });

  it("refuses a file without a top-level version", () => {
    for (const source of [
      "name: x\n",
      "  version: 0.1.0\n",
      "image:\n  version: 0.1.0\n",
      "appVersion: 0.1.0\n",
      "# version: 0.1.0\n",
      "version:\n",
      "version: 'unterminated\n",
      "",
    ]) {
      assert.throws(
        () => bumpedVersionFile("a.yaml", source, "1.0.0"),
        /a\.yaml has no top-level version field/,
        JSON.stringify(source),
      );
    }
  });
});

describe("bumpedVersionFile", () => {
  it("refuses a file of another format", () => {
    assert.throws(
      () => bumpedVersionFile("VERSION", "1.0.0\n", "1.0.1"),
      /not a \.json, \.yml or \.yaml file/,
    );
  });
});
