import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { UsageError } from "../errors.mts";
import {
  api,
  CommandError,
  getRepositoryName,
  runCommand,
} from "../github/gh.mts";
import { assetPath } from "../package-root.mts";
import { repositoryRoot } from "../repository-root.mts";
import {
  nextVersion,
  parseNotesConfig,
  pullRequestsInRange,
  releaseChanges,
  renderNotes,
  versionOfTag,
} from "./notes.mts";
import type { NotesConfig, PullRequest } from "./notes.mts";

// A repository without its own release notes config gets the shipped one.
const NOTES_CONFIG = ".github/release-notes.json";
// The search for merged pull requests starts this long before the commit the
// last release tagged. A pull request merged into another branch earlier,
// whose merge commit only reached main later, is still found within it.
const SEARCH_MARGIN_DAYS = 30;
// GitHub's search returns at most this many results for one query.
const SEARCH_LIMIT = 1000;

export interface Release {
  id: number;
  draft: boolean;
  tag_name: string;
  name: string;
  html_url: string;
  target_commitish: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BUMP_SUBJECT_PREFIX = "chore(release): set the version to ";

/**
 * The version a draft release resolves to: its tag without the tag prefix.
 * Drafting keeps one draft, so a second one is an error to resolve
 * before syncing, not a choice to make here.
 */
export function draftVersion(
  releases: Release[],
  tagPrefix: string,
): {
  version: string;
  draft: Release;
} {
  const drafts = releases.filter((release) => release.draft);
  if (drafts.length === 0) {
    throw new Error(
      "No draft release. Run repo-kit release draft, or let CI on main redraft it.",
    );
  }
  if (drafts.length > 1) {
    throw new Error(
      `Several draft releases (${drafts.map((d) => d.tag_name).join(", ")}); delete the stale ones.`,
    );
  }
  const draft = drafts[0]!;
  const version = draft.tag_name.startsWith(tagPrefix)
    ? draft.tag_name.slice(tagPrefix.length)
    : "";
  if (!VERSION.test(version)) {
    throw new Error(
      `The draft's tag "${draft.tag_name}" is not ${tagPrefix}<major>.<minor>.<patch>.`,
    );
  }
  return { version, draft };
}

/**
 * The package manifest with its version replaced and nothing else touched:
 * the field is rewritten in place so the file keeps its formatting. Only the
 * top-level field, at one level of indentation, counts; a nested "version"
 * key such as a script name is left alone.
 */
export function bumpedManifest(manifest: string, version: string): string {
  const pattern = /^( {2}"version"\s*:\s*")([^"]*)(")/m;
  if (!pattern.test(manifest)) {
    throw new Error("package.json has no top-level version field.");
  }
  return manifest.replace(pattern, `$1${version}$3`);
}

/**
 * The subject and body of the version bump commit. The commit is made with
 * hooks off, so the tests hold the message to the commitlint rules instead.
 */
export function bumpMessage(
  version: string,
  tagPrefix: string,
): [string, string] {
  return [
    `${BUMP_SUBJECT_PREFIX}${version}`,
    `The draft release names ${tagPrefix}${version} as the\n` +
      "next release. Publishing the draft tags main, so the tagged commit\n" +
      "names the version it releases.",
  ];
}

export function currentVersion(manifest: string): string {
  return (JSON.parse(manifest) as { version?: string }).version ?? "";
}

/**
 * Whether version `a` comes before `b`. A prerelease comes before the
 * release it leads to; two prereleases of one version compare by their
 * suffix, numerically where both parts are numbers.
 */
export function isLowerVersion(a: string, b: string): boolean {
  const parse = (version: string) => {
    const [core = "", pre] = version.split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  if (left.pre === undefined || right.pre === undefined) {
    return left.pre !== undefined && right.pre === undefined;
  }
  const leftParts = left.pre.split(".");
  const rightParts = right.pre.split(".");
  for (let index = 0; index < leftParts.length; index++) {
    const l = leftParts[index]!;
    const r = rightParts[index];
    if (r === undefined) return false;
    if (l === r) continue;
    const numeric = /^\d+$/.test(l) && /^\d+$/.test(r);
    return numeric ? Number(l) < Number(r) : l < r;
  }
  return leftParts.length < rightParts.length;
}

/**
 * The commits of `git log --format="%H %s"` output that are not version
 * bumps: the changes on main that a draft targeting an older commit does
 * not list.
 */
export function unlistedCommits(log: string): string[] {
  return log
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) =>
        !line.slice(line.indexOf(" ") + 1).startsWith(BUMP_SUBJECT_PREFIX),
    );
}

export function parsePublishArguments(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const value of argv) {
    if (value === "--dry-run") dryRun = true;
    else throw new UsageError(`Unknown argument: ${value}`);
  }
  return { dryRun };
}

export function parseSyncArguments(argv: string[]): {
  version?: string;
  tag?: string;
} {
  const values = [...argv];
  let version: string | undefined;
  let tag: string | undefined;
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--version") {
      version = values.shift();
      if (!version || !VERSION.test(version)) {
        throw new UsageError("--version requires <major>.<minor>.<patch>.");
      }
    } else if (value === "--tag") {
      tag = values.shift();
      if (!tag) throw new UsageError("--tag requires a release tag.");
    } else throw new UsageError(`Unknown argument: ${value}`);
  }
  if (version !== undefined && tag !== undefined) {
    throw new UsageError("Use either --version or --tag, not both.");
  }
  return {
    ...(version === undefined ? {} : { version }),
    ...(tag === undefined ? {} : { tag }),
  };
}

/** The version a release tag names, with the configured tag prefix. */
function versionOfReleaseTag(tag: string): string {
  const config = readNotesConfig();
  const version = versionOfTag(tag, config);
  if (version === undefined) {
    throw new Error(
      `The tag "${tag}" is not ${config.tagPrefix}<major>.<minor>.<patch>.`,
    );
  }
  return version;
}

function git(args: string[], cwd: string = repositoryRoot()): string {
  return runCommand("git", ["-C", cwd, ...args]);
}

function readNotesConfig(): NotesConfig {
  const own = path.join(repositoryRoot(), NOTES_CONFIG);
  const file = existsSync(own)
    ? own
    : assetPath("release", "release-notes.json");
  return parseNotesConfig(readFileSync(file, "utf8"));
}

/**
 * Set the root package version in the given checkout of main to `version`
 * and push the commit to main. Returns false when main already carries it.
 */
function bumpAndPush(workTree: string, version: string): boolean {
  const file = path.join(workTree, "package.json");
  const manifest = readFileSync(file, "utf8");
  if (currentVersion(manifest) === version) return false;
  writeFileSync(file, bumpedManifest(manifest, version));
  git(["add", "package.json"], workTree);
  // The checkout may have no node_modules, so the commit-msg hook's
  // commitlint cannot run there; bumpMessage follows the convention it
  // checks.
  const [subject, body] = bumpMessage(version, readNotesConfig().tagPrefix);
  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      subject,
      "-m",
      body,
    ],
    workTree,
  );
  git(["push", "origin", "HEAD:refs/heads/main"], workTree);
  return true;
}

/**
 * Set the version on main to `version` in a temporary worktree of `base`, so
 * the checked-out branch is left alone. Returns whether a commit was pushed
 * and the commit main then ends at.
 */
function bumpMain(
  base: string,
  version: string,
): { pushed: boolean; head: string } {
  const workTree = mkdtempSync(path.join(tmpdir(), "release-"));
  try {
    git(["worktree", "add", "--detach", workTree, base]);
    const pushed = bumpAndPush(workTree, version);
    return { pushed, head: git(["rev-parse", "HEAD"], workTree) };
  } finally {
    try {
      git(["worktree", "remove", "--force", workTree]);
    } catch {
      rmSync(workTree, { recursive: true, force: true });
      git(["worktree", "prune"]);
    }
  }
}

function readDraft(repository: string): { version: string; draft: Release } {
  const releases = api<Release[]>(
    "GET",
    `/repos/${repository}/releases?per_page=30`,
  )!;
  return draftVersion(releases, readNotesConfig().tagPrefix);
}

/**
 * Set the root package version on main to the draft release's, without
 * publishing it. With --version, or --tag for the tag of a release just
 * published, the version is given and the repository root is the checkout of
 * main to commit in; a version lower than main's is left alone, so a release
 * published for an older line does not move main back. Without them, the
 * draft is read from GitHub and the commit is made in a temporary worktree,
 * so the checked-out branch is left alone.
 */
export function sync(argv: string[]): void {
  const args = parseSyncArguments(argv);
  const given =
    args.tag === undefined ? args.version : versionOfReleaseTag(args.tag);
  if (given !== undefined) {
    const current = currentVersion(
      readFileSync(path.join(repositoryRoot(), "package.json"), "utf8"),
    );
    if (isLowerVersion(given, current)) {
      console.log(`main is at ${current}, past ${given}; left as it is.`);
      return;
    }
    const pushed = bumpAndPush(repositoryRoot(), given);
    console.log(
      pushed
        ? `Set the version to ${given} on main.`
        : `main is already at ${given}.`,
    );
    return;
  }

  const { version, draft } = readDraft(getRepositoryName());
  console.log(`Draft release: ${draft.name} (${draft.tag_name})`);
  git(["fetch", "origin", "main"]);
  const { pushed } = bumpMain(git(["rev-parse", "origin/main"]), version);
  console.log(
    pushed
      ? `Set the version to ${version} on main. Publish with repo-kit release publish.`
      : `main is already at ${version}. Publish with repo-kit release publish.`,
  );
}

/** A release's target as a commit: a SHA as it is, a branch from origin. */
function targetCommit(target: string): string {
  return git([
    "rev-parse",
    "--verify",
    `${/^[0-9a-f]{40}$/.test(target) ? target : `origin/${target}`}^{commit}`,
  ]);
}

/**
 * Publish the draft release: set the version on main to the draft's with a
 * commit, then publish the draft on that commit, so the tag names a commit
 * that carries its version. It refuses while main has changes the draft does
 * not list yet, which the redraft after CI passes on main catches up on.
 * --dry-run checks and prints what it would do, without doing it.
 */
export function publish(argv: string[]): void {
  const { dryRun } = parsePublishArguments(argv);
  const repository = process.env.GITHUB_REPOSITORY ?? getRepositoryName();
  const { version, draft } = readDraft(repository);
  console.log(`Draft release: ${draft.name} (${draft.tag_name})`);

  git(["fetch", "--quiet", "--tags", "origin", "main"]);
  if (git(["tag", "--list", draft.tag_name])) {
    throw new Error(
      `The tag ${draft.tag_name} already exists; publishing would attach the release to it.`,
    );
  }
  const base = git(["rev-parse", "origin/main"]);
  let target: string;
  try {
    target = targetCommit(draft.target_commitish);
    git(["merge-base", "--is-ancestor", target, base]);
  } catch {
    throw new Error(
      `The draft targets ${draft.target_commitish.slice(0, 7)}, which is not on main. Wait for the redraft that follows CI on main.`,
    );
  }
  const unlisted = unlistedCommits(
    git(["log", "--format=%H %s", `${target}..${base}`]),
  );
  if (unlisted.length > 0) {
    throw new Error(
      [
        `main has ${unlisted.length} commit(s) the draft does not list yet:`,
        ...unlisted.map((line) => `  ${line.slice(0, 7)}${line.slice(40)}`),
        "Publish once the draft has been redrafted after CI passes on main.",
      ].join("\n"),
    );
  }

  if (dryRun) {
    console.log(
      `Would set the version on main (${base.slice(0, 7)}) to ${version} and publish ${draft.tag_name} on it.`,
    );
    return;
  }
  const { pushed, head } = bumpMain(base, version);
  console.log(
    pushed
      ? `Set the version to ${version} on main (${head.slice(0, 7)}).`
      : `main is already at ${version} (${head.slice(0, 7)}).`,
  );
  const published = api<Release>(
    "PATCH",
    `/repos/${repository}/releases/${draft.id}`,
    { target_commitish: head, draft: false },
  )!;
  console.log(`Published ${published.html_url}`);
}

export function parseDraftArguments(argv: string[]): {
  target?: string;
  dryRun: boolean;
} {
  const values = [...argv];
  let target: string | undefined;
  let dryRun = false;
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--dry-run") dryRun = true;
    else if (value === "--target") {
      target = values.shift();
      if (!target || !/^[0-9a-f]{7,40}$/.test(target)) {
        throw new UsageError("--target requires a commit SHA.");
      }
    } else throw new UsageError(`Unknown argument: ${value}`);
  }
  return target === undefined ? { dryRun } : { target, dryRun };
}

const SEARCH_QUERY = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        mergedAt
        author { login }
        labels(first: 100) { nodes { name } }
        mergeCommit { oid }
      }
    }
  }
}`;

interface SearchPage {
  data: {
    search: {
      issueCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        number?: number;
        title?: string;
        mergedAt?: string | null;
        author?: { login: string } | null;
        labels?: { nodes: Array<{ name: string }> };
        mergeCommit?: { oid: string } | null;
      }>;
    };
  };
}

/** Every pull request merged into any branch of the repository since `since`. */
function mergedPullRequests(
  repository: string,
  since: string | undefined,
): PullRequest[] {
  const search = `repo:${repository} is:pr is:merged${since ? ` merged:>=${since}` : ""}`;
  const pullRequests: PullRequest[] = [];
  let cursor: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${SEARCH_QUERY}`,
      "-f",
      `search=${search}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const page = (JSON.parse(runCommand("gh", args)) as SearchPage).data.search;
    if (page.issueCount > SEARCH_LIMIT) {
      throw new Error(
        `${page.issueCount} pull requests merged since the last release, more than GitHub's search returns; publish a release to start a new range.`,
      );
    }
    for (const node of page.nodes) {
      if (!node.number || !node.mergeCommit || !node.mergedAt) continue;
      pullRequests.push({
        number: node.number,
        title: node.title ?? "",
        // A deleted account shows as ghost, as it does on GitHub.
        author: node.author?.login ?? "ghost",
        labels: (node.labels?.nodes ?? []).map(({ name }) => name),
        mergedAt: node.mergedAt,
        mergeCommit: node.mergeCommit.oid,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return pullRequests;
}

function latestReleaseTag(repository: string): string | undefined {
  try {
    return api<{ tag_name: string }>(
      "GET",
      `/repos/${repository}/releases/latest`,
    )!.tag_name;
  } catch (error) {
    if (error instanceof CommandError && error.httpStatus === 404) {
      return undefined;
    }
    throw error;
  }
}

function sinceDate(tag: string): string {
  const committed = new Date(git(["log", "-1", "--format=%cI", tag]));
  committed.setUTCDate(committed.getUTCDate() - SEARCH_MARGIN_DAYS);
  return committed.toISOString().slice(0, 10);
}

/**
 * Point the one draft release at `target` with the given tag, name and notes,
 * creating it when there is none. A release published while this run worked
 * out the notes is left alone: writing it would turn it back into a draft, or
 * draft its tag a second time. Returns undefined then.
 */
function writeDraft(
  repository: string,
  release: { tag_name: string; name: string; body: string },
  target: string,
): string | undefined {
  const releases = api<Release[]>(
    "GET",
    `/repos/${repository}/releases?per_page=100`,
  )!;
  if (releases.some((r) => !r.draft && r.tag_name === release.tag_name)) {
    return undefined;
  }
  const drafts = releases.filter((candidate) => candidate.draft);
  if (drafts.length > 1) {
    throw new Error(
      `Several draft releases (${drafts.map((d) => d.tag_name).join(", ")}); delete the stale ones.`,
    );
  }
  const payload = { ...release, target_commitish: target, draft: true };
  if (drafts[0]) {
    const current = api<Release>(
      "GET",
      `/repos/${repository}/releases/${drafts[0].id}`,
    )!;
    if (!current.draft) return undefined;
    return api<Release>(
      "PATCH",
      `/repos/${repository}/releases/${drafts[0].id}`,
      payload,
    )!.html_url;
  }
  return api<Release>("POST", `/repos/${repository}/releases`, payload)!
    .html_url;
}

/**
 * Draft the next release from the pull requests whose merge commit landed on
 * main since the last release, up to `--target` (the head of main by
 * default). It prints the version; the version on main changes only when the
 * draft is published (or with sync). With nothing to release it leaves the
 * draft alone. --dry-run prints the draft without writing it.
 */
export function draft(argv: string[]): void {
  const { target: given, dryRun } = parseDraftArguments(argv);
  const repository = process.env.GITHUB_REPOSITORY ?? getRepositoryName();
  const config = readNotesConfig();

  git(["fetch", "--quiet", "--tags", "origin", "main"]);
  const target = given ?? git(["rev-parse", "origin/main"]);
  const lastTag = latestReleaseTag(repository);
  const lastVersion = lastTag ? versionOfTag(lastTag, config) : "0.0.0";
  if (lastVersion === undefined) {
    throw new Error(
      `The latest release's tag "${lastTag}" is not ${config.tagPrefix}<major>.<minor>.<patch>.`,
    );
  }

  const range = lastTag ? `${lastTag}..${target}` : target;
  const commits = new Set(git(["rev-list", range]).split("\n").filter(Boolean));
  const pullRequests = pullRequestsInRange(
    mergedPullRequests(repository, lastTag ? sinceDate(lastTag) : undefined),
    commits,
  );
  const changes = releaseChanges(pullRequests, config);
  if (!changes) {
    console.log(
      `Nothing to release since ${lastTag ?? "the start of the history"}.`,
    );
    return;
  }

  const version = nextVersion(lastVersion, changes.increment);
  const release = {
    tag_name: `${config.tagPrefix}${version}`,
    name: config.name.replaceAll("{version}", version),
    body: renderNotes(changes.sections, config),
  };
  console.log(
    `${release.name}: ${pullRequests.length} pull request(s) since ${lastTag ?? "the start of the history"}, ${changes.increment} increment, target ${target.slice(0, 7)}.`,
  );
  if (dryRun) {
    console.log(`\n${release.body}`);
    return;
  }
  const written = writeDraft(repository, release, target);
  console.log(
    written
      ? `Drafted ${written}`
      : `${release.tag_name} was published meanwhile; the draft is left alone.`,
  );
}
