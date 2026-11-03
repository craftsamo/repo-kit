import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CommandError, runCommand } from "../github/gh.mts";
import { assetPath } from "../package-root.mts";
import { type NotesConfig, parseNotesConfig } from "../release/notes.mts";
import type {
  Check,
  PackageManager,
  ProjectInfo,
  ReleaseLabel,
} from "./project.mts";

const CONVENTIONAL_COMMIT = /^[a-z]+(\([^()\s]+\))?!?: \S/;
const MINIMUM_CONVENTIONAL_SUBJECTS = 5;

const WORKFLOW_FILE = /\.(ya?ml)$/i;
const RELEASE_DRAFT_WORKFLOW =
  "craftsamo/repo-kit/.github/workflows/release-draft.yml";

/** Matches the name of a license file, such as `LICENSE.md` or `COPYING`. */
export const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.\-_]|$)/i;

const KNOWN_PACKAGE_MANAGERS: readonly PackageManager[] = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
];

const CHECK_SCRIPTS = [
  "format:check",
  "lint",
  "typecheck",
  "test",
  "build",
] as const;

function isPackageManager(name: string): name is PackageManager {
  return (KNOWN_PACKAGE_MANAGERS as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelsFromConfig(config: NotesConfig): ReleaseLabel[] {
  const labels: ReleaseLabel[] = [];
  const seen = new Set<string>();

  const add = (label: string, effect: ReleaseLabel["effect"]) => {
    if (seen.has(label)) return;
    seen.add(label);
    labels.push({ label, effect });
  };

  for (const label of config.major) {
    add(label, "major");
  }
  for (const label of config.exclude) {
    add(label, "excluded");
  }
  for (const category of config.categories) {
    if (!category.labels) continue;
    const effect = category.increment === "minor" ? "minor" : "patch";
    for (const label of category.labels) {
      add(label, effect);
    }
  }

  return labels;
}

function findLicenseFile(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  return readdirSync(root).find((entry) => LICENSE_FILE.test(entry));
}

function installCommand(root: string, manager: PackageManager): string {
  switch (manager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
      return existsSync(path.join(root, "package-lock.json"))
        ? "npm ci"
        : "npm install";
  }
}

function checkCommand(script: string, manager: PackageManager): string {
  switch (manager) {
    case "pnpm":
    case "npm":
      return script === "test" ? `${manager} test` : `${manager} run ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
  }
}

/**
 * The non-merge commit subjects of the repository, up to 50, newest first.
 * Returns an empty list when git fails, such as in a repository without commits.
 */
export function readCommitSubjects(root: string): string[] {
  try {
    const output = runCommand("git", [
      "-C",
      root,
      "log",
      "--no-merges",
      "-n",
      "50",
      "--format=%s",
    ]);
    if (!output) return [];
    return output.split(/\r?\n/).filter((line) => line.length > 0);
  } catch (error) {
    if (error instanceof CommandError) return [];
    throw error;
  }
}

/**
 * Whether at least half of the subjects follow Conventional Commits.
 * Requires at least 5 subjects to make a decision.
 */
export function usesConventionalCommits(subjects: readonly string[]): boolean {
  if (subjects.length < MINIMUM_CONVENTIONAL_SUBJECTS) return false;
  const matches = subjects.filter((subject) =>
    CONVENTIONAL_COMMIT.test(subject),
  ).length;
  return matches >= subjects.length / 2;
}

/**
 * How pull request labels map to release increments in this repository,
 * read from .github/release-notes.json or repo-kit's release-draft workflow default.
 */
export function readReleaseLabels(root: string): ReleaseLabel[] | undefined {
  const configPath = path.join(root, ".github", "release-notes.json");
  if (existsSync(configPath)) {
    const config = parseNotesConfig(readFileSync(configPath, "utf8"));
    return labelsFromConfig(config);
  }

  const workflowDir = path.join(root, ".github", "workflows");
  if (existsSync(workflowDir)) {
    const entries = readdirSync(workflowDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !WORKFLOW_FILE.test(entry.name)) continue;
      const content = readFileSync(path.join(workflowDir, entry.name), "utf8");
      if (content.includes(RELEASE_DRAFT_WORKFLOW)) {
        const defaultAsset = assetPath("release", "release-notes.json");
        const config = parseNotesConfig(readFileSync(defaultAsset, "utf8"));
        return labelsFromConfig(config);
      }
    }
  }

  return undefined;
}

/**
 * Reads a repository's files to detect its package manager, checks, release
 * configuration and metadata.
 */
export function detectProject(
  root: string,
  subjects: readonly string[] = readCommitSubjects(root),
): ProjectInfo {
  const conventionalCommits = usesConventionalCommits(subjects);
  const release = readReleaseLabels(root);
  const agentsFile = existsSync(path.join(root, "AGENTS.md"));
  const licenseFile = findLicenseFile(root);

  const manifestPath = path.join(root, "package.json");
  if (!existsSync(manifestPath)) {
    return {
      corepack: false,
      checks: [],
      conventionalCommits,
      ...(release === undefined ? {} : { release }),
      agentsFile,
      ...(licenseFile === undefined ? {} : { licenseFile }),
    };
  }

  let manifest: Record<string, unknown>;
  try {
    const content = readFileSync(manifestPath, "utf8");
    const raw = JSON.parse(content);
    if (!isRecord(raw)) {
      throw new Error("package.json is not valid JSON.");
    }
    manifest = raw;
  } catch {
    throw new Error("package.json is not valid JSON.");
  }

  let packageManager: PackageManager;
  let corepack = false;

  const specifiedManager =
    typeof manifest.packageManager === "string"
      ? manifest.packageManager.split("@")[0]!
      : "";

  if (isPackageManager(specifiedManager)) {
    packageManager = specifiedManager;
    corepack = true;
  } else if (existsSync(path.join(root, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (existsSync(path.join(root, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (
    existsSync(path.join(root, "bun.lock")) ||
    existsSync(path.join(root, "bun.lockb"))
  ) {
    packageManager = "bun";
  } else {
    packageManager = "npm";
  }

  const engines = isRecord(manifest.engines) ? manifest.engines : undefined;
  const nodeVersion =
    typeof engines?.node === "string" ? engines.node : undefined;

  const scripts = isRecord(manifest.scripts) ? manifest.scripts : undefined;

  const checks: Check[] = [];
  if (scripts) {
    for (const script of CHECK_SCRIPTS) {
      if (typeof scripts[script] === "string") {
        checks.push({
          script,
          command: checkCommand(script, packageManager),
        });
      }
    }
  }

  return {
    packageManager,
    corepack,
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
    install: installCommand(root, packageManager),
    checks,
    conventionalCommits,
    ...(release === undefined ? {} : { release }),
    agentsFile,
    ...(licenseFile === undefined ? {} : { licenseFile }),
  };
}
