export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A script a contributor runs before pushing, such as the tests. */
export interface Check {
  /** The script's name in package.json, such as `test`. */
  script: string;
  /** The command that runs it, such as `pnpm test`. */
  command: string;
}

/** How a pull request label moves the next release. */
export interface ReleaseLabel {
  label: string;
  effect: "major" | "minor" | "patch" | "excluded";
}

/** What `setup community` reads from a repository to fill its templates. */
export interface ProjectInfo {
  /** Undefined when the repository has no package.json. */
  packageManager?: PackageManager;
  /** Whether package.json names its package manager, for `corepack enable`. */
  corepack: boolean;
  /** `engines.node` from package.json. */
  nodeVersion?: string;
  /** The command that installs the dependencies, such as `pnpm install`. */
  install?: string;
  /** The checks package.json defines, in the order a contributor runs them. */
  checks: Check[];
  /** Whether most recent commit subjects follow Conventional Commits. */
  conventionalCommits: boolean;
  /** Labels and their effect, when releases come from repo-kit's release. */
  release?: ReleaseLabel[];
  /** Whether the repository has an AGENTS.md at its root. */
  agentsFile: boolean;
  /** The name of the license file at the repository root, as spelled there. */
  licenseFile?: string;
}
