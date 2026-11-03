import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import type { Interface } from "node:readline/promises";

import { UsageError } from "../errors.mts";
import { api, CommandError, getRepositoryName } from "../github/gh.mts";
import type { ApiRequest, RepositoryRestState } from "../github/gh.mts";
import { getCurrentLabels, readLabels } from "../github/labels.mts";
import { getPrivateVulnerabilityReporting } from "../github/setup.mts";
import { repositoryRoot } from "../repository-root.mts";
import { detectProject, LICENSE_FILE } from "./detect.mts";
import { listTodos, renderCommunityFiles } from "./render.mts";
import type { CommunityFile } from "./render.mts";

export interface SetupCommunityArguments {
  license?: string;
  dryRun: boolean;
  yes: boolean;
}

export interface CommunityPlan {
  write: CommunityFile[];
  skip: Array<{ path: string; existing: string }>;
}

interface LicenseResponse {
  body: string;
}

interface UserResponse {
  name?: string | null;
}

/** The places GitHub looks for community files, from the repository root. */
const COMMUNITY_DIRECTORIES = ["", ".github", "docs"] as const;

const LICENSE_PATH = "LICENSE";

const ISSUE_TEMPLATE_DIRECTORY = ".github/ISSUE_TEMPLATE";
const PULL_REQUEST_TEMPLATE_FILE = ".github/PULL_REQUEST_TEMPLATE.md";

const NOT_FOUND = 404;

export function parseCommunityArguments(
  argv: string[],
): SetupCommunityArguments {
  const args: SetupCommunityArguments = { dryRun: false, yes: false };
  const values = [...argv];

  while (values.length > 0) {
    const value = values.shift();

    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--yes") args.yes = true;
    else if (value === "--license") {
      const id = values.shift();
      if (!id || id.startsWith("--")) {
        throw new UsageError("--license requires a value.");
      }
      args.license = id.toLowerCase();
    } else {
      throw new UsageError(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function readDirectory(root: string, directory: string): Dirent[] {
  try {
    return readdirSync(path.join(root, directory), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Whether a name is `base` or `base.<ext>`, ignoring case. */
function isNamed(name: string, base: string, bare: boolean): boolean {
  const lower = name.toLowerCase();
  return (bare && lower === base) || lower.startsWith(`${base}.`);
}

/** The first entry in the community directories that `accept` takes. */
function findEntry(
  root: string,
  accept: (entry: Dirent) => boolean,
): string | undefined {
  for (const directory of COMMUNITY_DIRECTORIES) {
    const entry = readDirectory(root, directory).find(accept);
    if (entry) return directory ? `${directory}/${entry.name}` : entry.name;
  }
  return undefined;
}

function findNamedFile(
  root: string,
  base: string,
  bare: boolean,
): string | undefined {
  return findEntry(
    root,
    (entry) => !entry.isDirectory() && isNamed(entry.name, base, bare),
  );
}

function findPullRequestTemplate(root: string): string | undefined {
  return findEntry(root, (entry) =>
    entry.isDirectory()
      ? entry.name.toLowerCase() === "pull_request_template"
      : isNamed(entry.name, "pull_request_template", false),
  );
}

/** A non-empty issue template directory, else a legacy single template. */
function findIssueTemplates(root: string): string | undefined {
  const directory = readDirectory(root, ".github").find(
    (entry) =>
      entry.isDirectory() && entry.name.toLowerCase() === "issue_template",
  );
  if (directory) {
    const existing = `.github/${directory.name}`;
    if (readDirectory(root, existing).length > 0) return existing;
  }
  return findNamedFile(root, "issue_template", false);
}

/**
 * The repository-relative path of a file GitHub already uses for the purpose
 * of `file`, in the root, `.github/` or `docs/`, or undefined when there is
 * none. Names compare case-insensitively and are reported as spelled.
 */
export function findExisting(root: string, file: string): string | undefined {
  if (file === LICENSE_PATH) {
    return readDirectory(root, "").find((entry) =>
      LICENSE_FILE.test(entry.name),
    )?.name;
  }
  if (file === PULL_REQUEST_TEMPLATE_FILE) return findPullRequestTemplate(root);
  if (file.startsWith(`${ISSUE_TEMPLATE_DIRECTORY}/`)) {
    return findIssueTemplates(root);
  }
  const base = path.posix.parse(file).name.toLowerCase();
  if (file === "CONTRIBUTING.md" || file === "SECURITY.md") {
    return findNamedFile(root, base, true);
  }
  return existsSync(path.join(root, file)) ? file : undefined;
}

export function planCommunityFiles(
  root: string,
  files: readonly CommunityFile[],
): CommunityPlan {
  const plan: CommunityPlan = { write: [], skip: [] };
  for (const file of files) {
    const existing = findExisting(root, file.path);
    if (existing === undefined) plan.write.push(file);
    else plan.skip.push({ path: file.path, existing });
  }
  return plan;
}

const isHttpStatus = (error: unknown, status: number): boolean =>
  error instanceof CommandError && error.httpStatus === status;

/**
 * The text of a license from GitHub, with the year and the owner's name
 * filled in. Other bracketed placeholders are left as they are.
 */
export function fetchLicense(
  id: string,
  owner: string,
  request: ApiRequest = api,
  year: number = new Date().getFullYear(),
): CommunityFile {
  let license: LicenseResponse | undefined;
  try {
    license = request<LicenseResponse>(
      "GET",
      `/licenses/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (!isHttpStatus(error, NOT_FOUND)) throw error;
    throw new UsageError(
      `Unknown license: ${id}. \`gh repo license list\` shows the ids.`,
      { cause: error },
    );
  }
  const user = request<UserResponse>(
    "GET",
    `/users/${encodeURIComponent(owner)}`,
  );
  const fullname = user?.name?.trim() || owner;
  return {
    path: LICENSE_PATH,
    content: license!.body
      .replaceAll("[year]", () => String(year))
      .replaceAll("[fullname]", () => fullname),
  };
}

/** Whether a real path is the real root or inside it. */
function isInside(realRoot: string, realPath: string): boolean {
  const relative = path.relative(realRoot, realPath);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** The path itself, or its nearest ancestor that exists. */
function nearestExisting(target: string): string {
  let current = target;
  while (!existsSync(current)) current = path.dirname(current);
  return current;
}

/**
 * Write each file, creating its directories. A file that appeared since the
 * plan was made is never overwritten: the write fails with EEXIST. A file whose
 * directory resolves outside the repository is not written. A failure stops at
 * that file and names the files already written.
 */
export function writeCommunityFiles(
  root: string,
  files: readonly CommunityFile[],
): void {
  const realRoot = realpathSync(root);
  const written: string[] = [];
  for (const file of files) {
    try {
      const target = path.join(root, file.path);
      const directory = path.dirname(target);
      const requireInside = (existing: string): void => {
        if (!isInside(realRoot, realpathSync(existing))) {
          throw new Error(`${file.path} resolves outside the repository`);
        }
      };
      requireInside(nearestExisting(directory));
      mkdirSync(directory, { recursive: true });
      requireInside(directory);
      writeFileSync(target, file.content, { flag: "wx" });
      written.push(file.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const progress = written.length
        ? `Already written: ${written.join(", ")}.`
        : "Nothing was written.";
      throw new Error(`Could not write ${file.path}: ${message}. ${progress}`, {
        cause: error,
      });
    }
  }
}

async function confirm(
  question: string,
  defaultValue: boolean,
  readline: Interface,
): Promise<boolean> {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await readline.question(`${question} [${hint}]: `))
    .trim()
    .toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

function printPlan(repository: string, plan: CommunityPlan): void {
  console.log(`Target repository: ${repository}`);
  if (plan.write.length > 0) {
    console.log("\nFiles to write");
    for (const file of plan.write) console.log(`  ${file.path}`);
  }
  if (plan.skip.length === 0) return;

  console.log("\nLeft as they are");
  const issueTemplates = plan.skip.filter((file) =>
    file.path.startsWith(`${ISSUE_TEMPLATE_DIRECTORY}/`),
  );
  const [firstIssueTemplate] = issueTemplates;
  for (const file of plan.skip) {
    if (!issueTemplates.includes(file)) {
      console.log(`  ${file.path} (found ${file.existing})`);
    } else if (file === firstIssueTemplate) {
      console.log(`  ${ISSUE_TEMPLATE_DIRECTORY}/ (found ${file.existing})`);
    }
  }
}

function printAfterWrite(
  plan: CommunityPlan,
  isPublic: boolean,
  privateReporting: boolean,
): void {
  console.log(`Wrote ${plan.write.length} files.`);

  const todos = plan.write.flatMap((file) =>
    listTodos(file.content).map((text) => `  ${file.path}: ${text}`),
  );
  if (todos.length > 0) {
    console.log("\nFill in the TODO comments before committing:");
    for (const line of todos) console.log(line);
  }
  if (
    !privateReporting &&
    plan.write.some((file) => file.path === "SECURITY.md")
  ) {
    console.log(
      isPublic
        ? "\nPrivate vulnerability reporting is off. Turn it on (repo-kit setup github does) to take reports through GitHub Security Advisories, then link it in SECURITY.md."
        : "\nSECURITY.md needs a private contact: GitHub's private vulnerability reporting is only for public repositories.",
    );
  }
  console.log("\nCommit the files when they read right.");
}

export async function run(argv: string[]): Promise<void> {
  const args = parseCommunityArguments(argv);
  const root = repositoryRoot();
  const repository = getRepositoryName();
  const state = api<RepositoryRestState>("GET", `/repos/${repository}`)!;
  const isPublic = state.visibility === "public";
  const privateReporting =
    isPublic && getPrivateVulnerabilityReporting(repository).enabled;

  const labels = (readLabels(root) ?? getCurrentLabels(repository)).map(
    (label) => label.name,
  );
  const project = detectProject(root);
  const license = args.license
    ? fetchLicense(args.license, repository.split("/")[0]!)
    : undefined;
  if (license && findExisting(root, LICENSE_PATH) === undefined) {
    project.licenseFile = LICENSE_PATH;
  }
  const files = renderCommunityFiles({
    repository,
    privateReporting,
    securityPolicy: findExisting(root, "SECURITY.md") ?? "SECURITY.md",
    project,
    labels,
  });
  if (license) files.push(license);

  const plan = planCommunityFiles(root, files);
  printPlan(repository, plan);
  if (plan.write.length === 0) {
    console.log(
      "Nothing to write; the repository already has every community file.",
    );
    return;
  }
  if (args.dryRun) {
    console.log("\nDry run complete. No files were written.");
    return;
  }

  if (!args.yes) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (!(await confirm("Write these files", false, readline))) {
        console.log("Cancelled.");
        return;
      }
    } finally {
      readline.close();
    }
  }

  writeCommunityFiles(root, plan.write);
  printAfterWrite(plan, isPublic, privateReporting);
}
