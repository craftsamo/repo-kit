import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fillTemplate,
  listTodos,
  pickLabel,
  renderCommunityFiles,
  todo,
} from "../../src/community/render.mts";

describe("fillTemplate", () => {
  it("replaces placeholders with provided values", () => {
    const result = fillTemplate("Hello {{name}}, welcome to {{place}}!", {
      name: "Alice",
      place: "Wonderland",
    });
    assert.equal(result, "Hello Alice, welcome to Wonderland!");
  });

  it("throws an error naming the key when a placeholder has no value", () => {
    assert.throws(
      () =>
        fillTemplate("Hello {{name}}, welcome to {{missing}}!", {
          name: "Alice",
        }),
      {
        message: /missing/,
      },
    );
  });
});

describe("todo and listTodos", () => {
  it("round trips a single TODO comment", () => {
    const comment = todo(
      "Describe how to set up the repository for development.",
    );
    assert.equal(
      comment,
      "<!-- TODO: Describe how to set up the repository for development. -->",
    );
    assert.deepEqual(listTodos(comment), [
      "Describe how to set up the repository for development.",
    ]);
  });

  it("lists multiple TODO comments in order", () => {
    const text = `
# Title
<!-- TODO: First step -->
Some text
<!-- TODO: Second step -->
`;
    assert.deepEqual(listTodos(text), ["First step", "Second step"]);
  });
});

describe("pickLabel", () => {
  it("matches case-insensitively and returns the repository spelling", () => {
    const labels = ["Bug", "enhancement"];
    assert.equal(pickLabel(labels, ["bug"]), "Bug");
  });

  it("respects the candidates priority order", () => {
    const labels = ["fix", "bug"];
    assert.equal(pickLabel(labels, ["bug", "fix"]), "bug");
    assert.equal(pickLabel(labels, ["fix", "bug"]), "fix");
  });

  it("returns undefined when no candidate matches", () => {
    const labels = ["documentation", "question"];
    assert.equal(pickLabel(labels, ["bug", "fix"]), undefined);
  });
});

describe("renderCommunityFiles", () => {
  it("renders files with full project info", () => {
    const context = {
      repository: "craftsamo/example-repo",
      privateReporting: true,
      securityPolicy: "SECURITY.md",
      labels: ["Bug", "enhancement", "question"],
      project: {
        packageManager: "pnpm",
        corepack: true,
        nodeVersion: ">=24",
        install: "pnpm install",
        checks: [
          { script: "test", command: "pnpm test" },
          { script: "build", command: "pnpm run build" },
        ],
        conventionalCommits: true,
        release: [
          { label: "breaking", effect: "major" },
          { label: "feature", effect: "minor" },
          { label: "skip-changelog", effect: "excluded" },
        ],
        agentsFile: true,
        licenseFile: "LICENSE",
      },
    };

    const files = renderCommunityFiles(context);

    // Assert paths and exact order
    assert.deepEqual(
      files.map((file) => file.path),
      [
        "CONTRIBUTING.md",
        "SECURITY.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/ISSUE_TEMPLATE/bug_report.yml",
        ".github/ISSUE_TEMPLATE/feature_request.yml",
        ".github/ISSUE_TEMPLATE/question.yml",
        ".github/ISSUE_TEMPLATE/config.yml",
      ],
    );

    // No unresolved placeholders left anywhere
    for (const file of files) {
      assert.ok(
        !file.content.includes("{{"),
        `Found unresolved placeholder in ${file.path}`,
      );
    }

    // No TODO except SECURITY's three fixed ones
    const allTodos = files.flatMap((file) => listTodos(file.content));
    assert.deepEqual(allTodos, [
      "Say which versions receive security fixes, such as the latest release.",
      "List what counts as a vulnerability in this project, and what does not.",
      "Say how soon reporters can expect a reply, and when advisories are published.",
    ]);

    const contributing = files.find((file) => file.path === "CONTRIBUTING.md");
    const security = files.find((file) => file.path === "SECURITY.md");
    const prTemplate = files.find(
      (file) => file.path === ".github/PULL_REQUEST_TEMPLATE.md",
    );
    const bugReport = files.find(
      (file) => file.path === ".github/ISSUE_TEMPLATE/bug_report.yml",
    );
    const config = files.find(
      (file) => file.path === ".github/ISSUE_TEMPLATE/config.yml",
    );

    // Setup block
    assert.ok(contributing.content.includes("You need Node.js `>=24`."));
    assert.ok(
      contributing.content.includes(
        "git clone https://github.com/craftsamo/example-repo.git\ncd example-repo\ncorepack enable\npnpm install",
      ),
    );

    // Release table rows
    assert.ok(contributing.content.includes("| Label | Next version |"));
    assert.ok(contributing.content.includes("| `breaking` | major |"));
    assert.ok(contributing.content.includes("| `feature` | minor |"));
    assert.ok(
      contributing.content.includes(
        "| `skip-changelog` | left out of the release notes |",
      ),
    );
    assert.ok(contributing.content.includes("| any other | patch |"));
    assert.ok(
      contributing.content.indexOf("| any other | patch |") <
        contributing.content.indexOf("| `skip-changelog` |"),
      "labels left out of the notes come after the patch rows",
    );

    // AGENTS.md sentence
    assert.ok(
      contributing.content.includes(
        "The rules the code itself follows are in [AGENTS.md](AGENTS.md), which AI coding agents read too.",
      ),
    );

    // PR template checklist with natural "and" join
    assert.ok(
      prTemplate.content.includes(
        "- [ ] `pnpm test` and `pnpm run build` pass",
      ),
    );

    // Issue template labels: ["Bug"]
    assert.ok(bugReport.content.includes('labels: ["Bug"]'));

    // Links to the security policy and the license
    assert.ok(
      contributing.content.includes(
        "Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes",
      ),
    );
    assert.ok(contributing.content.includes("[license](LICENSE)"));

    // Advisory links
    assert.ok(
      security.content.includes(
        "https://github.com/craftsamo/example-repo/security/advisories/new",
      ),
    );
    assert.ok(
      config.content.includes(
        "https://github.com/craftsamo/example-repo/security/advisories/new",
      ),
    );
  });

  it("renders files with empty project info", () => {
    const context = {
      repository: "craftsamo/example-repo",
      privateReporting: false,
      securityPolicy: "SECURITY.md",
      labels: [],
      project: {
        corepack: false,
        checks: [],
        conventionalCommits: false,
        agentsFile: false,
      },
    };

    const files = renderCommunityFiles(context);

    const contributing = files.find((file) => file.path === "CONTRIBUTING.md");
    const security = files.find((file) => file.path === "SECURITY.md");
    const prTemplate = files.find(
      (file) => file.path === ".github/PULL_REQUEST_TEMPLATE.md",
    );
    const config = files.find(
      (file) => file.path === ".github/ISSUE_TEMPLATE/config.yml",
    );

    // Assert setup/checks/commits/reporting TODOs appear
    assert.ok(
      contributing.content.includes(
        "<!-- TODO: Describe how to set up the repository for development. -->",
      ),
    );
    assert.ok(
      contributing.content.includes(
        "<!-- TODO: List the commands a contributor runs before pushing, such as the tests. -->",
      ),
    );
    assert.ok(
      contributing.content.includes(
        "<!-- TODO: Describe how commit messages are written. -->",
      ),
    );
    assert.ok(
      security.content.includes(
        "<!-- TODO: Say how to report a vulnerability privately, such as an email address or GitHub's private vulnerability reporting. -->\n\nDo not open a public issue or pull request for it.",
      ),
    );
    assert.ok(!security.content.includes("security/advisories/new"));

    // PR template fallback checklist
    assert.ok(
      prTemplate.content.includes("- [ ] The checks in CONTRIBUTING.md pass"),
    );

    // No release table
    assert.ok(!contributing.content.includes("| Label | Next version |"));
    assert.ok(
      !contributing.content.includes("A maintainer labels the pull request."),
    );

    // No License section
    assert.ok(!contributing.content.includes("## License"));

    // No labels: line in any file
    for (const file of files) {
      assert.ok(
        !file.content.split("\n").some((line) => line.startsWith("labels:")),
        `Found labels: line in ${file.path}`,
      );
    }

    // config.yml has no advisory link
    assert.ok(!config.content.includes("security/advisories/new"));
    assert.ok(!config.content.includes("Report a vulnerability"));

    // No line of 3+ consecutive blank lines in Markdown
    for (const file of files.filter((f) => f.path.endsWith(".md"))) {
      assert.ok(
        !/\n{3,}/.test(file.content),
        `Found 3+ consecutive newlines in ${file.path}`,
      );
    }
  });

  describe("with overrides", () => {
    const baseContext = {
      repository: "craftsamo/example-repo",
      privateReporting: false,
      securityPolicy: "SECURITY.md",
      labels: [],
      project: {
        corepack: false,
        checks: [],
        conventionalCommits: false,
        agentsFile: false,
      },
    };

    const render = (overrides = {}) => {
      const files = renderCommunityFiles({ ...baseContext, ...overrides });
      return (filePath) => files.find((file) => file.path === filePath).content;
    };

    it("links the advisory form only when private reporting is on", () => {
      const advisory = "security/advisories/new";
      const config = ".github/ISSUE_TEMPLATE/config.yml";

      const on = render({ privateReporting: true });
      assert.ok(on("SECURITY.md").includes(advisory));
      assert.ok(on(config).includes(advisory));

      const off = render({ privateReporting: false });
      assert.ok(!off("SECURITY.md").includes(advisory));
      assert.ok(!off(config).includes(advisory));
      assert.ok(off(config).includes("name: README"));
    });

    it("links the security policy at its path under its own name", () => {
      const content = render({ securityPolicy: ".github/SECURITY.md" })(
        "CONTRIBUTING.md",
      );
      assert.ok(content.includes("[SECURITY.md](.github/SECURITY.md)"));
    });

    it("links the license file under its real name", () => {
      const content = render({
        project: { ...baseContext.project, licenseFile: "LICENSE.md" },
      })("CONTRIBUTING.md");
      assert.ok(content.includes("[license](LICENSE.md)"));
    });

    it("puts the labels line right before body in every issue form", () => {
      const read = render({ labels: ["Bug", "enhancement", "question"] });
      const expected = {
        "bug_report.yml": 'labels: ["Bug"]',
        "feature_request.yml": 'labels: ["enhancement"]',
        "question.yml": 'labels: ["question"]',
      };
      for (const [form, labelsLine] of Object.entries(expected)) {
        const lines = read(`.github/ISSUE_TEMPLATE/${form}`).split("\n");
        const index = lines.indexOf(labelsLine);
        assert.notEqual(index, -1, `No top-level labels line in ${form}`);
        assert.equal(lines[index + 1], "body:", form);
      }

      const none = render();
      for (const form of Object.keys(expected)) {
        const content = none(`.github/ISSUE_TEMPLATE/${form}`);
        assert.ok(!content.includes("labels:"), form);
      }
    });
  });
});
