// The steps of the opencode reusable workflow, as `repo-kit ci opencode <step>`:
//   route    print which agent the comment asks for (no credentials)
//   prepare  parse the comment, fetch context, write the prompt (GH_TOKEN)
//   run      run the agent with the model candidates (provider keys only)
//   publish  post the answer, review, or build commit to GitHub (GH_TOKEN)
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { UsageError } from "../../errors.mts";
import { assetPath } from "../../package-root.mts";
import { repositoryRoot } from "../../repository-root.mts";
import { findAgentOverrides } from "./overrides.mts";
import {
  buildBranchName,
  fallbackBuildSummary,
  parseBuildOutput,
  pullRequestBody,
  workflowChanges,
} from "./build.mts";
import {
  checkCommand,
  isPullRequestTarget,
  parseCommand,
  type AgentName,
  type Target,
} from "./command.mts";
import {
  BASE_REF,
  buildPrompt,
  HEAD_REF,
  readEvent,
  type CommentInfo,
  type PullInfo,
} from "./context.mts";
import { parseDefaultModels, resolveModelSource } from "./models.mts";
import {
  neutralizeMentions,
  parseRunOutput,
  redactSecrets,
  SECRET_VARIABLES,
  type RunOutcome,
} from "./output.mts";
import {
  buildReviewPayload,
  commentableLines,
  parseReviewOutput,
} from "./review.mts";
import {
  buildRunArgs,
  footer,
  runWithFallback,
  type RunResult,
} from "./runner.mts";

// The agent config ships with repo-kit, while the repository the agent works
// on is the one the workflow checked out.
const configDir = assetPath("opencode");

/** Every CI agent, primary or subagent, by the file that defines it. */
function ciAgentIds(): string[] {
  return readdirSync(path.join(configDir, "agents"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length));
}
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_COMMENT = 60_000;
// The ci-workflow input of the opencode workflow sets CI_WORKFLOW.
const DEFAULT_CI_WORKFLOW = "tests.yml";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
// A dispatched CI run is not attached to the pull request, so it cannot
// satisfy required checks; these say how to get a pull_request run.
const REQUIRED_CHECKS_ON_NEW_PR =
  "To run the required checks on the pull request, approve its workflow run that is waiting for approval.";
const REQUIRED_CHECKS_ON_PUSH =
  "To run the required checks on this commit, close and reopen the pull request.";

interface Destination {
  repository: string;
  number: number;
  // Root comment of the review thread to answer in, when there is one.
  threadId?: number | undefined;
}

// Where a build commits: the working tree the agent edits, its git directory
// (kept outside the tree, out of the agent's reach), and the branch it is
// pushed to. `baseBranch` is set when the branch is new and needs a PR.
interface BuildTarget {
  workTree: string;
  gitDir: string;
  branch: string;
  baseBranch?: string | undefined;
}

// Git for the build clone. The explicit git dir ignores the tree's .git
// pointer, and hooks and fsmonitor stay off, so nothing the agent wrote runs
// while the token is in the environment.
function buildGitArgs(build: BuildTarget): string[] {
  return [
    "--git-dir",
    build.gitDir,
    "--work-tree",
    build.workTree,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
  ];
}

interface Meta extends Destination {
  agent: AgentName;
  target: Target;
  instruction: string;
  permalinkBase: string;
  headSha: string;
  runUrl: string;
  build?: BuildTarget | undefined;
}

type Json = Record<string, unknown>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function workDir(): string {
  const dir = path.join(requireEnv("RUNNER_TEMP"), "opencode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function setOutput(name: string, value: string): void {
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

function exec(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, {
    cwd: repositoryRoot(),
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function api<T>(method: string, endpoint: string, body?: unknown): T {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const output = exec(
    "gh",
    args,
    body === undefined ? undefined : JSON.stringify(body),
  );
  return (output.trim() ? JSON.parse(output) : undefined) as T;
}

function apiPages<T>(endpoint: string): T[] {
  const pages = JSON.parse(
    exec("gh", ["api", "--paginate", "--slurp", endpoint]),
  ) as T[][];
  return pages.flat();
}

// Authenticate git with the workflow token through gh so no credential is
// ever written to .git/config, where the agent could read it.
function gitWithToken(args: string[]): string {
  return exec("git", [
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    ...args,
  ]);
}

function gitFetch(refspecs: string[]): void {
  gitWithToken(["fetch", "--no-tags", "origin", ...refspecs]);
}

function limit(text: string): string {
  return text.length <= MAX_COMMENT
    ? text
    : `${text.slice(0, MAX_COMMENT)}\n\n… (truncated)`;
}

function reply(destination: Destination, body: string): void {
  const { repository, number, threadId } = destination;
  if (threadId !== undefined) {
    try {
      api(
        "POST",
        `/repos/${repository}/pulls/${number}/comments/${threadId}/replies`,
        { body: limit(body) },
      );
      return;
    } catch (error) {
      console.log(
        `::warning::Thread reply failed, commenting on the pull request: ${error}`,
      );
    }
  }
  api("POST", `/repos/${repository}/issues/${number}/comments`, {
    body: limit(body),
  });
}

// Cosmetic, so a failure (for example a read-only token) never stops a run.
function react(repository: string, target: Target, commentId: number): void {
  const kind = target === "pull_request_review_comment" ? "pulls" : "issues";
  try {
    api(
      "POST",
      `/repos/${repository}/${kind}/comments/${commentId}/reactions`,
      { content: "eyes" },
    );
  } catch (error) {
    console.log(`::warning::Could not add a reaction: ${error}`);
  }
}

function login(user: unknown): string {
  const value = (user as Json | null)?.login;
  return typeof value === "string" ? value : "ghost";
}

function readCommand() {
  const event = readEvent(
    requireEnv("GITHUB_EVENT_NAME"),
    readJson<unknown>(requireEnv("GITHUB_EVENT_PATH")),
  );
  if (!event) return undefined;
  const command = parseCommand(event.commentBody, event.target);
  return command.kind === "run" ? { event, command } : undefined;
}

// Lets the workflow pick the job, and with it the token permissions, before
// any credential is in play. prepare validates the command afterwards.
function route(): void {
  setOutput("agent", readCommand()?.command.agent ?? "");
}

function prepare(): void {
  const request = readCommand();
  if (!request) {
    setOutput("agent", "");
    return;
  }
  const { event, command } = request;

  const repository = requireEnv("GITHUB_REPOSITORY");
  const destination: Destination = {
    repository,
    number: event.number,
    threadId: event.reviewThread?.rootCommentId,
  };
  const check = checkCommand(command, event.target);
  if (!check.ok) {
    reply(destination, check.message);
    setOutput("agent", "");
    return;
  }

  const issue = api<Json>("GET", `/repos/${repository}/issues/${event.number}`);
  const comments: CommentInfo[] = apiPages<Json>(
    `/repos/${repository}/issues/${event.number}/comments?per_page=100`,
  )
    .filter((comment) => comment.id !== event.commentId)
    .map((comment) => ({
      author: login(comment.user),
      body: String(comment.body ?? ""),
    }));
  // A command in a review thread usually answers its first comment, such as
  // a review finding, so the whole thread goes into the prompt.
  const threadId = event.reviewThread?.rootCommentId;
  const threadComments: CommentInfo[] =
    threadId === undefined
      ? []
      : apiPages<Json>(
          `/repos/${repository}/pulls/${event.number}/comments?per_page=100`,
        )
          .filter(
            (comment) =>
              comment.id !== event.commentId &&
              (comment.id === threadId || comment.in_reply_to_id === threadId),
          )
          .map((comment) => ({
            author: login(comment.user),
            body: String(comment.body ?? ""),
          }));

  let pull: PullInfo | undefined;
  let headSha = exec("git", ["rev-parse", "HEAD"]).trim();
  let build: BuildTarget | undefined;
  const workTree = path.join(workDir(), "worktree");
  const gitDir = path.join(workDir(), "build.git");
  if (isPullRequestTarget(event.target)) {
    const pr = api<Json>("GET", `/repos/${repository}/pulls/${event.number}`);
    const base = pr.base as Json;
    const head = pr.head as Json;
    if (command.agent === "build") {
      if ((head.repo as Json | null)?.full_name !== repository) {
        reply(
          destination,
          "`build` cannot push to pull requests from forks. Ask the author to make the change, or use `/oc plan` for a proposal.",
        );
        setOutput("agent", "");
        return;
      }
      build = { workTree, gitDir, branch: String(head.ref) };
    }
    gitFetch([
      `+refs/pull/${event.number}/head:${HEAD_REF}`,
      `+refs/heads/${String(base.ref)}:${BASE_REF}`,
    ]);
    // The fetched ref, not the API response, is what the agent reads; a push
    // in between would otherwise misplace inline comments.
    headSha = exec("git", ["rev-parse", HEAD_REF]).trim();
    pull = {
      baseBranch: String(base.ref),
      headLabel: String(head.label),
      headSha,
      files: apiPages<Json>(
        `/repos/${repository}/pulls/${event.number}/files?per_page=100`,
      ).map((file) => ({
        filename: String(file.filename),
        status: String(file.status),
        additions: Number(file.additions),
        deletions: Number(file.deletions),
      })),
    };
  } else if (command.agent === "build") {
    build = {
      workTree,
      gitDir,
      branch: buildBranchName(
        event.number,
        requireEnv("GITHUB_RUN_ID"),
        process.env.GITHUB_RUN_ATTEMPT ?? "1",
      ),
      baseBranch: exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    };
  }
  react(repository, event.target, event.commentId);

  // The agent edits a separate clone, so the scripts and agent config the
  // later steps run stay the default branch's. Its git directory sits outside
  // the tree, where the agent cannot edit it.
  if (build) {
    exec("git", [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--separate-git-dir",
      build.gitDir,
      repositoryRoot(),
      build.workTree,
    ]);
    const git = buildGitArgs(build);
    if (!build.baseBranch) {
      exec("git", [
        ...git,
        "fetch",
        "--quiet",
        repositoryRoot(),
        `+${HEAD_REF}:${HEAD_REF}`,
        `+${BASE_REF}:${BASE_REF}`,
      ]);
    }
    exec("git", [...git, "checkout", "--quiet", "--detach", headSha]);
  }

  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const meta: Meta = {
    ...destination,
    agent: command.agent,
    target: event.target,
    instruction: command.instruction,
    build,
    permalinkBase: `${server}/${repository}/blob/${headSha}`,
    headSha,
    runUrl: `${server}/${repository}/actions/runs/${requireEnv("GITHUB_RUN_ID")}`,
  };
  const prompt = buildPrompt({
    agent: command.agent,
    instruction: command.instruction,
    quote: command.quote,
    repository,
    event,
    issue: {
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      author: login(issue.user),
      url: String(issue.html_url ?? ""),
    },
    pull,
    comments,
    threadComments,
    permalinkBase: meta.permalinkBase,
  });

  const dir = workDir();
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(path.join(dir, "prompt.md"), prompt);
  setOutput("agent", command.agent);
}

function runOpenCode(
  agent: AgentName,
  model: string,
  prompt: string,
  xdg: string,
  cwd: string,
): RunOutcome {
  // Unset secrets reach the step as empty strings; drop them so OpenCode
  // treats those providers as unconfigured.
  // OpenCode takes its project directory from PWD, which spawn does not
  // update, so it must follow cwd or the agent works in the parent's checkout.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: cwd,
    XDG_CONFIG_HOME: xdg,
  };
  for (const name of SECRET_VARIABLES) {
    if (!env[name]) delete env[name];
  }

  console.log(`::group::opencode run --agent ${agent} --model ${model}`);
  const child = spawnSync("opencode", buildRunArgs(agent, model), {
    cwd,
    encoding: "utf8",
    env,
    input: prompt,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
    timeout: RUN_TIMEOUT_MS,
  });
  console.log("::endgroup::");

  if (child.error) {
    const timedOut =
      (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      text: "",
      error: timedOut
        ? {
            type: "timeout",
            message: `opencode run did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes.`,
          }
        : { type: "spawn", message: child.error.message },
    };
  }
  const outcome = parseRunOutput(child.stdout ?? "");
  if (!outcome.error && child.status !== 0) {
    return {
      ...outcome,
      error: { type: "exit", message: `opencode exited with ${child.status}.` },
    };
  }
  return outcome;
}

function runAgent(): void {
  const dir = workDir();
  const meta = readJson<Meta>(path.join(dir, "meta.json"));
  const prompt = readFileSync(path.join(dir, "prompt.md"), "utf8");

  let result: RunResult;
  try {
    const defaults = parseDefaultModels(
      readFileSync(path.join(configDir, "models.json"), "utf8"),
    );
    const source = resolveModelSource(meta.agent, process.env, defaults);
    const xdg = path.join(dir, "xdg");
    cpSync(configDir, path.join(xdg, "opencode"), { recursive: true });
    const cwd = meta.build?.workTree ?? repositoryRoot();
    const overrides = findAgentOverrides(cwd, ciAgentIds());
    if (overrides.length > 0) {
      throw new Error(
        [
          "The repository configures CI agents, which would change what they may do:",
          ...overrides.map((line) => `- ${line}`),
          "Rename or remove these to use /oc.",
        ].join("\n"),
      );
    }
    result = runWithFallback(source, (model) =>
      runOpenCode(meta.agent, model, prompt, xdg, cwd),
    );
  } catch (error) {
    result = { ok: false, text: "", error: String(error), tried: [] };
  }

  const redacted: RunResult = {
    ...result,
    text: redactSecrets(result.text, process.env),
  };
  if (result.error) {
    redacted.error = redactSecrets(result.error, process.env);
  }
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(redacted));
  console.log(
    redacted.ok
      ? `Answered with ${redacted.model}.`
      : `Failed: ${redacted.error}`,
  );
}

function publishReview(meta: Meta, text: string, foot: string): boolean {
  const parsed = parseReviewOutput(text);
  if (!parsed) return false;
  // Finding bodies sit inside the json fence, so neutralize them one by one.
  const review = {
    summary: neutralizeMentions(parsed.summary),
    findings: parsed.findings.map((finding) => ({
      ...finding,
      body: neutralizeMentions(finding.body),
    })),
  };

  const diff = exec("git", [
    "-c",
    "core.quotePath=false",
    "diff",
    `${BASE_REF}...${HEAD_REF}`,
  ]);
  const options = {
    commitId: meta.headSha,
    permalinkBase: meta.permalinkBase,
    footer: foot,
  };
  const endpoint = `/repos/${meta.repository}/pulls/${meta.number}/reviews`;
  const payload = buildReviewPayload(review, commentableLines(diff), options);
  try {
    api("POST", endpoint, { ...payload, body: limit(payload.body) });
  } catch (error) {
    console.log(`::warning::Inline review failed, posting a comment: ${error}`);
    reply(meta, buildReviewPayload(review, new Map(), options).body);
  }
  return true;
}

function formatFailure(agent: AgentName, error: string, foot: string): string {
  const detail = neutralizeMentions(error).replaceAll("```", "'''");
  return `OpenCode could not complete \`${agent}\`.\n\n\`\`\`text\n${detail}\n\`\`\`\n\n${foot}`;
}

// Pushes and PRs made with GITHUB_TOKEN start no workflows; workflow_dispatch
// is the exception, so the CI workflow is started explicitly.
function dispatchTests(repository: string, ref: string): string {
  const workflow = process.env.CI_WORKFLOW || DEFAULT_CI_WORKFLOW;
  try {
    api(
      "POST",
      `/repos/${repository}/actions/workflows/${workflow}/dispatches`,
      { ref },
    );
    return `Started the ${workflow} workflow on \`${ref}\`.`;
  } catch (error) {
    console.log(
      `::warning::Could not start the ${workflow} workflow: ${error}`,
    );
    return `Could not start the ${workflow} workflow; run it from the Actions tab.`;
  }
}

function publishBuild(
  meta: Meta,
  build: BuildTarget,
  text: string,
  foot: string,
): void {
  const git = (args: string[], input?: string) =>
    exec("git", [...buildGitArgs(build), ...args], input);
  const parsed =
    parseBuildOutput(text) ??
    fallbackBuildSummary(text, meta.instruction, meta.number);
  const summary = neutralizeMentions(parsed.summary);
  // Says why on the request, then fails the step.
  function fail(message: string): never {
    reply(meta, formatFailure("build", message, foot));
    throw new Error(message);
  }

  let changed: string[];
  try {
    git(["add", "--all"]);
    // Without rename detection a file moved out of .github/workflows/ still
    // shows its old path.
    changed = git(["diff", "--cached", "--name-only", "--no-renames", "-z"])
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    fail(`Could not stage the changes.\n${error}`);
  }
  if (changed.length === 0) {
    reply(meta, `OpenCode \`build\` made no changes.\n\n${summary}\n\n${foot}`);
    return;
  }
  const blocked = workflowChanges(changed);
  if (blocked.length > 0) {
    fail(
      `The changes touch workflow files, which the workflow token cannot push:\n${blocked.join("\n")}`,
    );
  }

  let sha: string;
  try {
    git(
      [
        "-c",
        `user.name=${BOT_NAME}`,
        "-c",
        `user.email=${BOT_EMAIL}`,
        "commit",
        "--quiet",
        "--no-verify",
        "--file",
        "-",
      ],
      parsed.commitMessage,
    );
    sha = git(["rev-parse", "HEAD"]).trim();
  } catch (error) {
    fail(`Could not commit the changes.\n${error}`);
  }

  // The clone's origin is the runner checkout, so push to GitHub by URL.
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  try {
    gitWithToken([
      ...buildGitArgs(build),
      "push",
      `${server}/${meta.repository}.git`,
      `HEAD:refs/heads/${build.branch}`,
    ]);
  } catch (error) {
    fail(
      `Could not push to ${build.branch}. If the branch moved while the agent worked, run the command again.\n${error}`,
    );
  }

  if (build.baseBranch) {
    let number: unknown;
    try {
      number = api<Json>("POST", `/repos/${meta.repository}/pulls`, {
        title: parsed.title,
        head: build.branch,
        base: build.baseBranch,
        body: limit(pullRequestBody(summary, meta.number, foot)),
      }).number;
    } catch (error) {
      fail(
        `Pushed ${build.branch}, but could not open a pull request. Allow GitHub Actions to create pull requests in the repository settings, or open it manually: ${server}/${meta.repository}/compare/${build.baseBranch}...${build.branch}?expand=1\n${error}`,
      );
    }
    const tests = dispatchTests(meta.repository, build.branch);
    reply(
      meta,
      `Opened #${number} from \`${build.branch}\`. ${tests}\n\n${REQUIRED_CHECKS_ON_NEW_PR}\n\n${foot}`,
    );
    return;
  }

  const tests = dispatchTests(meta.repository, build.branch);
  const commit = `[\`${sha.slice(0, 7)}\`](${server}/${meta.repository}/commit/${sha})`;
  reply(
    meta,
    `Pushed ${commit} to \`${build.branch}\`. ${tests}\n\n${summary}\n\n${REQUIRED_CHECKS_ON_PUSH}\n\n${foot}`,
  );
}

function publish(): void {
  const dir = workDir();
  const meta = readJson<Meta>(path.join(dir, "meta.json"));
  const resultFile = path.join(dir, "result.json");
  const result: RunResult = existsSync(resultFile)
    ? readJson<RunResult>(resultFile)
    : {
        ok: false,
        text: "",
        error: "The agent step did not produce a result.",
        tried: [],
      };
  const foot = footer(meta.agent, result.model, meta.runUrl);

  if (!result.ok) {
    const error = result.error ?? "Unknown error.";
    reply(meta, formatFailure(meta.agent, error, foot));
    throw new Error(error);
  }
  if (meta.build) {
    publishBuild(meta, meta.build, result.text, foot);
    return;
  }
  if (meta.agent === "review" && publishReview(meta, result.text, foot)) return;
  reply(meta, `${neutralizeMentions(result.text)}\n\n${foot}`);
}

const steps: Record<string, () => void> = {
  route,
  prepare,
  run: runAgent,
  publish,
};

export function run(argv: string[]): void {
  const [name = "", ...rest] = argv;
  const step = steps[name];
  if (!step || rest.length > 0) {
    throw new UsageError(
      `Usage: repo-kit ci opencode ${Object.keys(steps).join("|")}`,
    );
  }
  step();
}
