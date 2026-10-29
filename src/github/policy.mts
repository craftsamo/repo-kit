import { AGENTS } from "../ci/opencode/command.mts";
import { agentVariable } from "../ci/opencode/models.mts";
import { SECRET_VARIABLES } from "../ci/opencode/output.mts";
import { UsageError } from "../errors.mts";

export type SetupMode = "setup" | "secrets";

export interface SetupArguments {
  mode: SetupMode;
  dryRun: boolean;
  defaults: boolean;
  yes: boolean;
  repository?: string | undefined;
  scope?: "repository" | undefined;
  environment?: string | undefined;
  secretName?: string | undefined;
  // The job every pull request into main must pass, and the workflow that
  // runs it, for a repository whose CI uses other names.
  requiredCheck: string;
  ciWorkflow: string;
}

export interface ObjectDiff {
  key: string;
  current: unknown;
  desired: unknown;
}

export interface RepositoryMetadata {
  description?: string;
  homepage?: string;
}

export interface RepositorySettings extends RepositoryMetadata {
  default_branch: string;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  has_discussions: boolean;
  allow_merge_commit: boolean;
  allow_squash_merge: boolean;
  allow_rebase_merge: boolean;
  allow_auto_merge: boolean;
  allow_update_branch: boolean;
  delete_branch_on_merge: boolean;
  merge_commit_title: string;
  merge_commit_message: string;
  squash_merge_commit_title: string;
  squash_merge_commit_message: string;
}

export interface ActionsPermissionsSettings {
  enabled: boolean;
  allowed_actions: "selected";
  sha_pinning_required: boolean;
}

export interface SelectedActionsSettings {
  github_owned_allowed: boolean;
  verified_allowed: boolean;
  patterns_allowed: string[];
}

export interface WorkflowSettings {
  default_workflow_permissions: "read";
  can_approve_pull_request_reviews: boolean;
}

export interface ActionsSettings {
  permissions: ActionsPermissionsSettings;
  selectedActions: SelectedActionsSettings;
  workflow: WorkflowSettings;
}

export interface ActionsPermissionsState {
  enabled?: boolean;
  allowed_actions?: string;
  sha_pinning_required?: boolean;
}

export interface SelectedActionsState {
  github_owned_allowed?: boolean;
  verified_allowed?: boolean;
  patterns_allowed?: string[];
}

export interface WorkflowState {
  default_workflow_permissions?: string;
  can_approve_pull_request_reviews?: boolean;
}

export interface ActionsState {
  permissions: ActionsPermissionsState;
  selectedActions: SelectedActionsState;
  workflow: WorkflowState;
}

export interface RetentionState {
  days?: number;
  maximum_allowed_days?: number;
}

export interface RetentionSettings {
  days: number;
}

export interface CacheRetentionState {
  max_cache_retention_days?: number;
}

export interface CacheRetentionSettings {
  max_cache_retention_days: number;
}

type FeatureStatus = { status: "enabled" | "disabled" };

export interface SecurityAndAnalysisSettings {
  secret_scanning: FeatureStatus;
  secret_scanning_push_protection: FeatureStatus;
}

export type SecurityAndAnalysisState = Partial<
  Record<keyof SecurityAndAnalysisSettings, Partial<FeatureStatus>>
>;

export interface DependabotSettings {
  vulnerability_alerts: boolean;
  security_updates: boolean;
}

export interface RestrictionUser {
  login?: string;
}

export interface RestrictionTeam {
  slug?: string;
}

export interface RestrictionApp {
  slug?: string;
}

export interface RestrictionsInput {
  users?: Array<string | RestrictionUser>;
  teams?: Array<string | RestrictionTeam>;
  apps?: Array<string | RestrictionApp>;
}

export interface RestrictionsOutput {
  users: Array<string | RestrictionUser>;
  teams: Array<string | RestrictionTeam>;
  apps: Array<string | RestrictionApp>;
}

export interface BranchStatusCheck {
  context: string;
  app_id?: number | null;
}

export interface BranchProtectionInput {
  required_status_checks?: {
    contexts?: string[];
    checks?: BranchStatusCheck[];
  };
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: {
    dismissal_restrictions?: RestrictionsInput | null;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
    require_last_push_approval?: boolean;
  };
  restrictions?: RestrictionsInput | null;
  required_linear_history?: { enabled?: boolean };
  block_creations?: { enabled?: boolean };
  lock_branch?: { enabled?: boolean };
  allow_fork_syncing?: { enabled?: boolean };
}

export interface BranchProtectionOutput {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
    checks?: BranchStatusCheck[];
  };
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismissal_restrictions?: RestrictionsOutput;
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    required_approving_review_count: number;
    require_last_push_approval: boolean;
  };
  restrictions: RestrictionsOutput | null;
  required_conversation_resolution: boolean;
  required_linear_history: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  block_creations: boolean;
  lock_branch: boolean;
  allow_fork_syncing: boolean;
}

export interface RulesetStatusCheck {
  context: string;
  integration_id?: number;
}

export interface RulesetInput {
  name: string;
  target: "branch";
  enforcement: "active";
  bypass_actors: Array<{
    actor_id: number | null;
    actor_type: "RepositoryRole" | "DeployKey";
    bypass_mode: "always";
  }>;
  conditions: {
    ref_name: {
      include: string[];
      exclude: string[];
    };
  };
  rules: Array<
    | { type: "deletion" }
    | { type: "non_fast_forward" }
    | {
        type: "pull_request";
        parameters: {
          allowed_merge_methods: Array<"merge" | "squash">;
          dismiss_stale_reviews_on_push: boolean;
          require_code_owner_review: boolean;
          require_last_push_approval: boolean;
          required_approving_review_count: number;
          required_review_thread_resolution: boolean;
        };
      }
    | {
        type: "required_status_checks";
        parameters: {
          strict_required_status_checks_policy: boolean;
          do_not_enforce_on_create: boolean;
          required_status_checks: RulesetStatusCheck[];
        };
      }
  >;
}

const REPOSITORY_RULESET_NAME = "Protect main";
const REQUIRED_CHECK = "Required checks";
const CI_WORKFLOW = "tests.yml";

// The deploy key the release workflow pushes the version bump to
// main with, and the repository secret that holds its private half.
export const RELEASE_KEY_TITLE = "Release version bump";
export const RELEASE_KEY_SECRET = "RELEASE_DEPLOY_KEY";

export interface ReleaseKeyState {
  key?: { id: number; read_only: boolean } | undefined;
  secret: boolean;
}

export type ReleaseKeyPlan = "keep" | "create" | "replace";

/**
 * The secret cannot be read back, so a writable key with its secret present
 * is kept, and anything else gets a new key pair: a missing half, or a key
 * that cannot push.
 */
export function planReleaseKey(state: ReleaseKeyState): ReleaseKeyPlan {
  if (state.key && !state.key.read_only && state.secret) return "keep";
  return state.key ? "replace" : "create";
}

// The OpenCode workflow's model variables and provider key secrets, taken
// from the workflow scripts so the two never drift apart.
export const MODEL_VARIABLES = ["OPENCODE_MODEL", ...AGENTS.map(agentVariable)];
export const PROVIDER_SECRETS: readonly string[] = SECRET_VARIABLES;
const ARTIFACT_RETENTION_DAYS = 30;
// GitHub drops a cache unused for 7 days. Three still spans a weekend, and
// drops the caches of merged branches before they crowd out main's in the
// repository's 10 GB cache quota.
const CACHE_RETENTION_DAYS = 3;

export function parseArguments(argv: string[]): SetupArguments {
  const args: SetupArguments = {
    mode: "setup",
    dryRun: false,
    defaults: false,
    yes: false,
    repository: undefined,
    scope: undefined,
    environment: undefined,
    secretName: undefined,
    requiredCheck: REQUIRED_CHECK,
    ciWorkflow: CI_WORKFLOW,
  };
  const ciOptions = new Set<string>();
  const values = [...argv];

  if (values[0] === "secrets") {
    args.mode = values.shift() as "secrets";
  }

  while (values.length > 0) {
    const value = values.shift();

    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--defaults") args.defaults = true;
    else if (value === "--yes") args.yes = true;
    else if (value === "--repo") args.repository = requireValue(value, values);
    else if (value === "--scope")
      args.scope = requireValue(value, values) as "repository";
    else if (value === "--environment") {
      args.environment = requireValue(value, values);
    } else if (value === "--name") {
      args.secretName = requireValue(value, values);
    } else if (value === "--required-check") {
      args.requiredCheck = requireValue(value, values);
      ciOptions.add(value);
    } else if (value === "--ci-workflow") {
      args.ciWorkflow = requireValue(value, values);
      ciOptions.add(value);
    } else {
      throw new UsageError(`Unknown argument: ${value}`);
    }
  }

  if (args.scope && args.scope !== "repository") {
    throw new UsageError("--scope only accepts 'repository'.");
  }
  if (args.scope && args.environment) {
    throw new UsageError("Use either --scope or --environment, not both.");
  }
  if (
    args.mode === "setup" &&
    (args.scope || args.environment || args.secretName)
  ) {
    throw new UsageError("Secret options require the secrets subcommand.");
  }
  if (args.mode === "secrets" && args.defaults) {
    throw new UsageError("Secrets cannot be configured with --defaults.");
  }
  if (args.mode === "secrets" && ciOptions.size > 0) {
    throw new UsageError(
      `${[...ciOptions].join(", ")} cannot be used with the secrets subcommand.`,
    );
  }
  if ((args.scope || args.environment) && !args.secretName) {
    throw new UsageError("--scope and --environment require --name.");
  }

  return args;
}

function requireValue(flag: string, values: string[]): string {
  const value = values.shift();
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

export function buildRepositorySettings(
  metadata: RepositoryMetadata = {},
): RepositorySettings {
  return {
    default_branch: "main",
    has_issues: true,
    has_projects: true,
    has_wiki: false,
    has_discussions: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    // Pull requests are kept current by a local rebase and force push, so
    // GitHub's merge-or-rebase Update branch suggestion stays off.
    allow_update_branch: false,
    delete_branch_on_merge: true,
    merge_commit_title: "PR_TITLE",
    merge_commit_message: "BLANK",
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    ...metadata,
  };
}

/**
 * The allowed-action patterns for every third-party action and reusable
 * workflow that the given workflow files use, each at any ref. A pattern
 * matches an action's full path, so allowing an action in a subdirectory,
 * such as Release Drafter's autolabeler, does not allow the repository's
 * root action. Local actions, Docker images and GitHub's own actions need no
 * pattern.
 */
export function workflowActionPatterns(workflows: readonly string[]): string[] {
  const patterns = new Set<string>();
  for (const source of workflows) {
    for (const match of source.matchAll(
      /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/gm,
    )) {
      const action = match[1]!;
      if (action.startsWith("./") || action.startsWith("docker://")) continue;
      if (/^(actions|github)\//.test(action)) continue;
      patterns.add(`${action.replace(/@.*$/, "")}@*`);
    }
  }
  return [...patterns].sort();
}

/**
 * Whether a workflow reads the release deploy key. Only then does setup
 * create the key and let deploy keys bypass the protection of main.
 */
export function usesReleaseKey(workflows: readonly string[]): boolean {
  const reference = new RegExp(`\\bsecrets\\.${RELEASE_KEY_SECRET}\\b`);
  return workflows.some((source) => reference.test(source));
}

export function buildActionsSettings({
  shaPinningRequired = false,
  allowedActions = [],
}: {
  shaPinningRequired?: boolean;
  allowedActions?: readonly string[];
} = {}): ActionsSettings {
  return {
    permissions: {
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: shaPinningRequired,
    },
    selectedActions: {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: [...allowedActions],
    },
    // `/oc build` opens pull requests with GITHUB_TOKEN. GitHub ties creating
    // and approving into this one setting; the workflow never approves.
    workflow: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: true,
    },
  };
}

// An organization may cap retention below setup's value; ask for the cap
// instead of a value GitHub would reject.
export function buildRetentionSettings(
  maximumAllowedDays?: number,
): RetentionSettings {
  return {
    days: maximumAllowedDays
      ? Math.min(ARTIFACT_RETENTION_DAYS, maximumAllowedDays)
      : ARTIFACT_RETENTION_DAYS,
  };
}

export function buildCacheRetentionSettings(): CacheRetentionSettings {
  return { max_cache_retention_days: CACHE_RETENTION_DAYS };
}

export function buildSecurityAndAnalysis(): SecurityAndAnalysisSettings {
  return {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  };
}

// Security updates open pull requests on their own, so they stay off unless
// requested.
export function buildDependabotSettings({
  securityUpdates = false,
}: {
  securityUpdates?: boolean;
} = {}): DependabotSettings {
  return { vulnerability_alerts: true, security_updates: securityUpdates };
}

export function buildMainRuleset(
  integrationId: number,
  {
    requiredCheck = REQUIRED_CHECK,
    releaseKey = false,
  }: { requiredCheck?: string; releaseKey?: boolean } = {},
): RulesetInput {
  return {
    name: REPOSITORY_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [
      {
        actor_id: 5,
        actor_type: "RepositoryRole",
        bypass_mode: "always",
      },
      // Deploy keys, so that the release workflow can push the version bump
      // to main with the release deploy key. GitHub accepts GitHub Actions as
      // a bypass actor only on organization repositories; a deploy key works
      // on personal ones as well.
      ...(releaseKey
        ? [
            {
              actor_id: null,
              actor_type: "DeployKey" as const,
              bypass_mode: "always" as const,
            },
          ]
        : []),
    ],
    conditions: {
      ref_name: {
        include: ["refs/heads/main"],
        exclude: [],
      },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            {
              context: requiredCheck,
              ...(integrationId ? { integration_id: integrationId } : {}),
            },
          ],
        },
      },
    ],
  };
}

export function buildBranchProtection(
  current: BranchProtectionInput = {},
  integrationId: number,
  requiredCheck: string = REQUIRED_CHECK,
): BranchProtectionOutput {
  const contexts = new Set(current.required_status_checks?.contexts ?? []);
  contexts.add(requiredCheck);
  const checks = new Map(
    (current.required_status_checks?.checks ?? []).map((check) => [
      `${check.context}:${check.app_id ?? ""}`,
      check,
    ]),
  );
  if (integrationId) {
    checks.set(`${requiredCheck}:${integrationId}`, {
      context: requiredCheck,
      app_id: integrationId,
    });
  }
  const reviews = current.required_pull_request_reviews ?? {};
  const dismissalRestrictions = mapRestrictions(reviews.dismissal_restrictions);

  return {
    required_status_checks: {
      strict: true,
      contexts: [...contexts],
      ...(checks.size > 0 ? { checks: [...checks.values()] } : {}),
    },
    enforce_admins: Boolean(current.enforce_admins?.enabled),
    required_pull_request_reviews: {
      ...(dismissalRestrictions
        ? { dismissal_restrictions: dismissalRestrictions }
        : {}),
      dismiss_stale_reviews: Boolean(reviews.dismiss_stale_reviews),
      require_code_owner_reviews: Boolean(reviews.require_code_owner_reviews),
      required_approving_review_count: Math.max(
        reviews.required_approving_review_count ?? 0,
        0,
      ),
      require_last_push_approval: Boolean(reviews.require_last_push_approval),
    },
    restrictions: mapRestrictions(current.restrictions),
    required_conversation_resolution: true,
    required_linear_history: Boolean(current.required_linear_history?.enabled),
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: Boolean(current.block_creations?.enabled),
    lock_branch: Boolean(current.lock_branch?.enabled),
    allow_fork_syncing: Boolean(current.allow_fork_syncing?.enabled),
  };
}

function mapRestrictions(
  restrictions: RestrictionsInput | null | undefined,
): RestrictionsOutput | null {
  if (!restrictions) return null;
  return {
    users: (restrictions.users ?? []).map((user) =>
      typeof user === "string" ? user : (user.login ?? user),
    ),
    teams: (restrictions.teams ?? []).map((team) =>
      typeof team === "string" ? team : (team.slug ?? team),
    ),
    apps: (restrictions.apps ?? []).map((app) =>
      typeof app === "string" ? app : (app.slug ?? app),
    ),
  };
}

// GitHub returns the allowed patterns in an order of its own, while setup
// sends them sorted, so the current list is sorted before the comparison.
export function normalizeSelectedActions(
  state: SelectedActionsState,
): SelectedActionsState {
  return state.patterns_allowed
    ? { ...state, patterns_allowed: [...state.patterns_allowed].sort() }
    : state;
}

export function diffObject<Current extends object, Desired extends object>(
  current: Current | undefined,
  desired: Desired,
): ObjectDiff[] {
  const currentRecord = current as Record<string, unknown> | undefined;
  return Object.entries(desired)
    .filter(
      ([key, value]) =>
        JSON.stringify(currentRecord?.[key]) !== JSON.stringify(value),
    )
    .map(([key, value]) => ({
      key,
      current: currentRecord?.[key],
      desired: value,
    }));
}

export { REPOSITORY_RULESET_NAME };
