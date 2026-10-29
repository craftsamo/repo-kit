import { execFileSync } from "node:child_process";

import { repositoryRoot } from "../repository-root.mts";

export interface CommandErrorFields {
  command: string;
  status: number | null | undefined;
  stderr: string;
  httpStatus: number;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiRequest = <T = unknown>(
  method: ApiMethod,
  endpoint: string,
  body?: unknown,
) => T | undefined;

export interface RunCommandOptions {
  inherit?: boolean | undefined;
  input?: string | undefined;
}

export interface RepositoryPermissions {
  admin?: boolean;
}

export interface RepositoryRestState {
  full_name: string;
  description?: string | null;
  homepage?: string | null;
  permissions?: RepositoryPermissions;
  [key: string]: unknown;
}

export interface PreflightResult {
  repository: string;
  state: RepositoryRestState;
}

export class CommandError extends Error implements CommandErrorFields {
  command: string;
  status: number | null | undefined;
  stderr: string;
  httpStatus: number;

  constructor(command: string, error: unknown) {
    const details =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : {};
    const stderr = String(details.stderr ?? "").trim();
    super(stderr || `${command} failed.`);
    this.name = "CommandError";
    this.command = command;
    this.status = details.status as number | null | undefined;
    this.stderr = stderr;
    this.httpStatus = Number(stderr.match(/HTTP (\d{3})/)?.[1]);
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions & { inherit: true },
): void;
export function runCommand(
  command: string,
  args: string[],
  options?: RunCommandOptions & { inherit?: false | undefined },
): string;
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): string | void {
  try {
    const output = execFileSync(command, args, {
      cwd: repositoryRoot(),
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      input: options.input,
    });
    if (options.inherit) return;
    return output.trim();
  } catch (error) {
    throw new CommandError(`${command} ${args.join(" ")}`, error);
  }
}

export function api<T = unknown>(
  method: ApiMethod,
  endpoint: string,
  body?: unknown,
): T | undefined {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const output = runCommand("gh", args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  return output ? (JSON.parse(output) as T) : undefined;
}

export function getRepositoryName(explicitRepository?: string): string {
  if (explicitRepository) return explicitRepository;
  return runCommand("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
}

/**
 * Report whether a deployment environment already exists.
 *
 * Asks for the single environment by name instead of scanning the environment
 * list: the list endpoint is paginated, so a repository with more environments
 * than one page would report an existing environment as missing.
 */
export function environmentExists(
  repository: string,
  name: string,
  request: ApiRequest = api,
): boolean {
  try {
    request(
      "GET",
      `/repos/${repository}/environments/${encodeURIComponent(name)}`,
    );
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.httpStatus === 404) return false;
    throw error;
  }
}

/**
 * Create a deployment environment when it is missing, and return whether it was
 * created.
 *
 * An existing environment is left untouched on purpose. `PUT /environments`
 * is an upsert whose omitted properties are reset, so re-sending it would strip
 * the protection rules (required reviewers, wait timer, branch policy) that a
 * repository administrator configured out of band.
 */
export function ensureEnvironment(
  repository: string,
  name: string,
  request: ApiRequest = api,
): boolean {
  if (environmentExists(repository, name, request)) return false;
  request(
    "PUT",
    `/repos/${repository}/environments/${encodeURIComponent(name)}`,
    {},
  );
  return true;
}

export function preflight(explicitRepository?: string): PreflightResult {
  runCommand("gh", ["--version"]);
  runCommand("gh", ["auth", "status"]);
  const repository = getRepositoryName(explicitRepository);
  const state = api<RepositoryRestState>(
    "GET",
    `/repos/${repository}`,
  ) as RepositoryRestState;

  if (!state.permissions?.admin) {
    throw new Error(`Admin permission is required for ${repository}.`);
  }

  try {
    api("GET", `/repos/${repository}/git/ref/heads/main`);
  } catch (error) {
    throw new Error(`${repository} must have a main branch before setup.`, {
      cause: error,
    });
  }

  return { repository, state };
}
