import { readFileSync } from "node:fs";
import path from "node:path";
import { assetPath } from "../package-root.mts";
import type { ProjectInfo } from "./project.mts";

const BUG_LABEL_CANDIDATES = ["bug", "fix", "type: bug"] as const;
const FEATURE_LABEL_CANDIDATES = ["enhancement", "feature"] as const;
const QUESTION_LABEL_CANDIDATES = ["question"] as const;

export interface CommunityContext {
  /** The repository in owner/name form. */
  repository: string;
  /** Whether the repository takes reports through GitHub's private vulnerability reporting. */
  privateReporting: boolean;
  /** The path CONTRIBUTING.md links for reporting a vulnerability. */
  securityPolicy: string;
  project: ProjectInfo;
  /** Label names that exist in the repository. */
  labels: readonly string[];
}

export interface CommunityFile {
  /** Path from the repository root. */
  path: string;
  content: string;
}

/**
 * Replaces `{{key}}` placeholders in a template with values from the given record.
 * Throws when a placeholder has no value.
 */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key) || values[key] === undefined) {
      throw new Error(`Missing template value for "${key}"`);
    }
    return values[key];
  });
}

/** Formats a TODO comment for markdown files. */
export function todo(text: string): string {
  return `<!-- TODO: ${text} -->`;
}

/** Extracts the text of all TODO comments in markdown content. */
export function listTodos(content: string): string[] {
  const matches = content.matchAll(/<!-- TODO: ([\s\S]*?) -->/g);
  return Array.from(matches, (match) => match[1] ?? "");
}

/**
 * Matches candidate label names against the repository's labels case-insensitively,
 * returning the repository's spelling of the first matching candidate.
 */
export function pickLabel(
  labels: readonly string[],
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    const match = labels.find(
      (label) => label.toLowerCase() === candidateLower,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function repositoryName(repository: string): string {
  const index = repository.lastIndexOf("/");
  return index === -1 ? repository : repository.slice(index + 1);
}

function securityAdvisoriesUrl(repository: string): string {
  return `https://github.com/${repository}/security/advisories/new`;
}

function naturalJoin(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  const first = items[0]!;
  if (items.length === 1) {
    return first;
  }
  const second = items[1]!;
  if (items.length === 2) {
    return `${first} and ${second}`;
  }
  const last = items[items.length - 1]!;
  return `${items.slice(0, -1).join(", ")} and ${last}`;
}

function buildSetup(context: CommunityContext, name: string): string {
  const { project, repository } = context;
  if (!project.packageManager) {
    return todo("Describe how to set up the repository for development.");
  }
  const lines: string[] = [];
  if (project.nodeVersion) {
    lines.push(`You need Node.js \`${project.nodeVersion}\`.`, "");
  }
  const commands = [
    `git clone https://github.com/${repository}.git`,
    `cd ${name}`,
  ];
  if (project.corepack) {
    commands.push("corepack enable");
  }
  commands.push(project.install ?? `${project.packageManager} install`);
  lines.push("```sh", ...commands, "```");
  return lines.join("\n");
}

function buildContributingChecks(project: ProjectInfo): string {
  if (project.checks.length === 0) {
    return todo(
      "List the commands a contributor runs before pushing, such as the tests.",
    );
  }
  const commands = project.checks.map((c) => c.command);
  return `Run these before you push:\n\n\`\`\`sh\n${commands.join("\n")}\n\`\`\``;
}

function buildCommits(project: ProjectInfo): string {
  if (project.conventionalCommits) {
    return "Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, in the imperative, such as `fix(parser): handle empty input`. Keep each commit to one change; the body says why, when the subject cannot.";
  }
  return todo("Describe how commit messages are written.");
}

function buildRelease(project: ProjectInfo): string {
  const { release } = project;
  if (!release) {
    return "";
  }
  const row = (label: string, effect: string) => `| ${label} | ${effect} |`;
  const labelled = (effect: string) =>
    release
      .filter((item) => item.effect === effect)
      .map((item) => row(`\`${item.label}\``, effect));
  const rows = [
    ...labelled("major"),
    ...labelled("minor"),
    ...labelled("patch"),
    row("any other", "patch"),
    ...release
      .filter((item) => item.effect === "excluded")
      .map((item) => row(`\`${item.label}\``, "left out of the release notes")),
  ];
  return [
    "A maintainer labels the pull request. The label decides how far the next version moves:",
    "",
    "| Label | Next version |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}

function buildLicense(project: ProjectInfo): string {
  if (project.licenseFile) {
    return `## License\n\nBy contributing, you agree that your contributions are licensed under the project's [license](${project.licenseFile}).`;
  }
  return "";
}

function buildSecurityLink(securityPolicy: string): string {
  return `[${path.posix.basename(securityPolicy)}](${securityPolicy})`;
}

function buildReporting(context: CommunityContext): string {
  if (context.privateReporting) {
    return `Report it through [GitHub Security Advisories](${securityAdvisoriesUrl(context.repository)}). Do not open a public issue or pull request for it.`;
  }
  return `${todo("Say how to report a vulnerability privately, such as an email address or GitHub's private vulnerability reporting.")}\n\nDo not open a public issue or pull request for it.`;
}

function buildPrChecks(project: ProjectInfo): string {
  if (project.checks.length === 0) {
    return "- [ ] The checks in CONTRIBUTING.md pass";
  }
  const commands = project.checks.map((c) => `\`${c.command}\``);
  return `- [ ] ${naturalJoin(commands)} pass`;
}

function buildLabelsField(
  labels: readonly string[],
  candidates: readonly string[],
): string {
  const picked = pickLabel(labels, candidates);
  return picked !== undefined ? `labels: ${JSON.stringify([picked])}` : "";
}

function buildContactLinks(context: CommunityContext): string {
  const links: string[] = [];
  if (context.privateReporting) {
    links.push(
      "  - name: Report a vulnerability",
      `    url: ${securityAdvisoriesUrl(context.repository)}`,
      "    about: Report it privately, never in a public issue.",
    );
  }
  links.push(
    "  - name: README",
    `    url: https://github.com/${context.repository}#readme`,
    "    about: The project documentation.",
  );
  return links.join("\n");
}

function cleanMarkdown(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function ensureNewline(content: string): string {
  return content.endsWith("\n") ? content : content + "\n";
}

/**
 * Renders the community health files for a repository from their templates.
 */
export function renderCommunityFiles(
  context: CommunityContext,
): CommunityFile[] {
  const name = repositoryName(context.repository);

  const files: Array<{
    asset: string[];
    path: string;
    values: Record<string, string>;
    markdown?: boolean;
  }> = [
    {
      asset: ["community", "CONTRIBUTING.md"],
      path: "CONTRIBUTING.md",
      values: {
        name,
        repository: context.repository,
        agents: context.project.agentsFile
          ? " The rules the code itself follows are in [AGENTS.md](AGENTS.md), which AI coding agents read too."
          : "",
        setup: buildSetup(context, name),
        checks: buildContributingChecks(context.project),
        commits: buildCommits(context.project),
        release: buildRelease(context.project),
        license: buildLicense(context.project),
        securityLink: buildSecurityLink(context.securityPolicy),
      },
      markdown: true,
    },
    {
      asset: ["community", "SECURITY.md"],
      path: "SECURITY.md",
      values: {
        reporting: buildReporting(context),
      },
      markdown: true,
    },
    {
      asset: ["community", "PULL_REQUEST_TEMPLATE.md"],
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      values: {
        checks: buildPrChecks(context.project),
      },
      markdown: true,
    },
    {
      asset: ["community", "ISSUE_TEMPLATE", "bug_report.yml"],
      path: ".github/ISSUE_TEMPLATE/bug_report.yml",
      values: {
        name,
        labels: buildLabelsField(context.labels, BUG_LABEL_CANDIDATES),
      },
    },
    {
      asset: ["community", "ISSUE_TEMPLATE", "feature_request.yml"],
      path: ".github/ISSUE_TEMPLATE/feature_request.yml",
      values: {
        labels: buildLabelsField(context.labels, FEATURE_LABEL_CANDIDATES),
      },
    },
    {
      asset: ["community", "ISSUE_TEMPLATE", "question.yml"],
      path: ".github/ISSUE_TEMPLATE/question.yml",
      values: {
        labels: buildLabelsField(context.labels, QUESTION_LABEL_CANDIDATES),
      },
    },
    {
      asset: ["community", "ISSUE_TEMPLATE", "config.yml"],
      path: ".github/ISSUE_TEMPLATE/config.yml",
      values: {
        contactLinks: buildContactLinks(context),
      },
    },
  ];

  return files.map(({ asset, path: filePath, values, markdown }) => {
    const template = readFileSync(assetPath(...asset), "utf8");
    const content = fillTemplate(template, values);
    return {
      path: filePath,
      content: markdown ? cleanMarkdown(content) : ensureNewline(content),
    };
  });
}
