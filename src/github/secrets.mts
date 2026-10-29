import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import process from "node:process";

import { parseArguments, PROVIDER_SECRETS } from "./policy.mts";
import type { SetupArguments } from "./policy.mts";
import {
  api,
  ensureEnvironment,
  environmentExists,
  preflight,
  runCommand,
} from "./gh.mts";
import { repositoryRoot } from "../repository-root.mts";
import type { PreflightResult } from "./gh.mts";

type Repository = PreflightResult["repository"];
type SecretName = string;
type SecretNames = SecretName[];

interface Environment {
  name: string;
}

interface EnvironmentApiResponse {
  environments: Environment[];
}

interface SecretApiResponse {
  name: SecretName;
}

type SecretTarget =
  { type: "repository" } | { type: "environment"; name: string };

async function ask(
  question: string,
  defaultValue: string,
  readline: Interface,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await readline.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue || "";
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

function validateSecretName(name: string): SecretName {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith("GITHUB_")) {
    throw new Error(
      "Secret names must use uppercase letters, numbers, and underscores, and cannot start with GITHUB_.",
    );
  }
  return name;
}

function listEnvironments(repository: Repository): Environment[] {
  return (
    api<EnvironmentApiResponse>(
      "GET",
      `/repos/${repository}/environments?per_page=100`,
    )!.environments ?? []
  );
}

async function chooseSecretTarget(
  repository: Repository,
  args: SetupArguments,
  readline: Interface,
): Promise<SecretTarget> {
  if (args.scope) return { type: "repository" };
  if (args.environment) return { type: "environment", name: args.environment };

  const environments = listEnvironments(repository);
  console.log("\nSecret scope");
  console.log("  1. Repository (global)");
  environments.forEach((environment, index) => {
    console.log(`  ${index + 2}. ${environment.name}`);
  });
  console.log(`  ${environments.length + 2}. Create an environment`);
  const choice = Number(await ask("Choose a scope", "1", readline));

  if (choice === 1) return { type: "repository" };
  if (choice >= 2 && choice <= environments.length + 1) {
    return { type: "environment", name: environments[choice - 2]!.name };
  }
  if (choice === environments.length + 2) {
    const name = await ask("Environment name", "production", readline);
    if (!name) throw new Error("Environment name is required.");
    return { type: "environment", name };
  }
  throw new Error("Invalid scope selection.");
}

function listSecretNames(
  repository: Repository,
  target: SecretTarget,
): SecretNames {
  const args = ["secret", "list", "--repo", repository, "--json", "name"];
  if (target.type === "environment") args.push("--env", target.name);
  return (JSON.parse(runCommand("gh", args)) as SecretApiResponse[]).map(
    ({ name }) => name,
  );
}

function setSecret(
  repository: Repository,
  target: SecretTarget,
  name: SecretName,
): void {
  const args = ["secret", "set", name, "--repo", repository];
  if (target.type === "environment") args.push("--env", target.name);
  const result = spawnSync("gh", args, {
    cwd: repositoryRoot(),
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Failed to set ${name}.`);
}

export async function setupSecrets(args: SetupArguments): Promise<void> {
  const { repository } = preflight(args.repository);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(`Target repository: ${repository}`);
    let names: SecretNames;
    let target: SecretTarget;

    if (args.secretName) {
      names = [validateSecretName(args.secretName)];
      target = await chooseSecretTarget(repository, args, readline);
    } else {
      const useProviderPreset = await confirm(
        "Configure AI provider API keys for the OpenCode workflow",
        true,
        readline,
      );
      if (useProviderPreset) {
        names = [];
        for (const name of PROVIDER_SECRETS) {
          if (await confirm(`Set ${name}`, false, readline)) names.push(name);
        }
        if (names.length === 0) {
          console.log("No provider keys selected.");
          return;
        }
        target = { type: "repository" };
      } else {
        names = [validateSecretName(await ask("Secret name", "", readline))];
        target = await chooseSecretTarget(repository, args, readline);
      }
    }

    const targetEnvironmentExists =
      target.type === "environment" &&
      environmentExists(repository, target.name);
    if (target.type === "environment") {
      if (!targetEnvironmentExists) {
        console.log(`Environment will be created: ${target.name}`);
      }
      console.warn(
        `Jobs must declare environment: ${target.name} to access these secrets.`,
      );
    }

    const existing =
      target.type === "environment" && !targetEnvironmentExists
        ? []
        : listSecretNames(repository, target);
    for (const name of names) {
      const action = existing.includes(name) ? "Overwrite" : "Create";
      console.log(`${action} ${target.type} secret: ${name}`);
    }
    if (args.dryRun) {
      console.log("Dry run complete. No secrets were changed.");
      return;
    }
    if (!args.yes && !(await confirm("Continue", false, readline))) {
      console.log("Secret setup cancelled.");
      return;
    }
    if (target.type === "environment") {
      ensureEnvironment(repository, target.name);
    }
    for (const name of names) setSecret(repository, target, name);
    console.log("Secret setup completed.");
  } finally {
    readline.close();
  }
}

export async function run(argv: string[]): Promise<void> {
  await setupSecrets(parseArguments(["secrets", ...argv]));
}
