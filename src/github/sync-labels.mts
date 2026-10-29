import { UsageError } from "../errors.mts";
import { getRepositoryName } from "./gh.mts";
import {
  applyLabels,
  diffLabels,
  getCurrentLabels,
  LABELS_FILE,
  printLabelDiff,
  readLabels,
} from "./labels.mts";

export interface SyncLabelsArguments {
  repository?: string | undefined;
  dryRun: boolean;
}

export function parseSyncLabelsArguments(argv: string[]): SyncLabelsArguments {
  const args: SyncLabelsArguments = { repository: undefined, dryRun: false };
  const values = [...argv];
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--repo") {
      const repository = values.shift();
      if (!repository || repository.startsWith("--")) {
        throw new UsageError("--repo requires a value.");
      }
      args.repository = repository;
    } else throw new UsageError(`Unknown argument: ${value}`);
  }
  return args;
}

/**
 * Make the repository's labels the ones .github/labels.yml declares: create
 * the missing ones, update the changed ones and delete the rest. A label
 * whose name only changes case is renamed, so it keeps its issues and pull
 * requests.
 */
export function run(argv: string[]): void {
  const args = parseSyncLabelsArguments(argv);
  const desired = readLabels();
  if (!desired) throw new Error(`${LABELS_FILE} not found.`);
  const repository = getRepositoryName(
    args.repository ?? process.env.GITHUB_REPOSITORY,
  );
  const changes = diffLabels(desired, getCurrentLabels(repository));

  console.log(`Repository: ${repository}`);
  printLabelDiff(changes);
  if (args.dryRun) {
    console.log("\nDry run complete. No labels were changed.");
    return;
  }
  applyLabels(repository, changes);
}
