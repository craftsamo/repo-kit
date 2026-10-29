import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildActionsSettings,
  buildBranchProtection,
  buildCacheRetentionSettings,
  buildDependabotSettings,
  buildMainRuleset,
  buildRepositorySettings,
  buildRetentionSettings,
  buildSecurityAndAnalysis,
  diffObject,
  MODEL_VARIABLES,
  normalizeSelectedActions,
  parseArguments,
  planReleaseKey,
  PROVIDER_SECRETS,
  usesReleaseKey,
  workflowActionPatterns,
} from "../../src/github/policy.mts";
import { UsageError } from "../../src/errors.mts";
import { CommandError } from "../../src/github/gh.mts";
import {
  applyActionsSettings,
  applyCacheRetention,
  run,
} from "../../src/github/setup.mts";

const httpError = (status, message) =>
  new CommandError("gh api", { stderr: `gh: ${message} (HTTP ${status})` });

describe("parseArguments", () => {
  const ci = { requiredCheck: "Required checks", ciWorkflow: "tests.yml" };

  it("reports a wrong argument as a usage error", () => {
    assert.throws(() => parseArguments(["--force"]), UsageError);
    assert.throws(() => parseArguments(["--repo"]), UsageError);
  });

  it("leaves secrets to their own command", async () => {
    await assert.rejects(run(["secrets"]), UsageError);
  });

  it("uses interactive repository setup by default", () => {
    assert.deepEqual(parseArguments([]), {
      mode: "setup",
      dryRun: false,
      defaults: false,
      yes: false,
      repository: undefined,
      scope: undefined,
      environment: undefined,
      secretName: undefined,
      ...ci,
    });
  });

  it("takes the required check and the workflow that runs it", () => {
    const args = parseArguments([
      "--required-check",
      "CI passed",
      "--ci-workflow",
      "ci.yml",
    ]);

    assert.equal(args.requiredCheck, "CI passed");
    assert.equal(args.ciWorkflow, "ci.yml");
    assert.throws(
      () => parseArguments(["--ci-workflow"]),
      /--ci-workflow requires a value/,
    );
    assert.throws(
      () => parseArguments(["secrets", "--required-check", "CI passed"]),
      /--required-check cannot be used with the secrets subcommand/,
    );
  });

  it("parses non-interactive setup flags", () => {
    assert.deepEqual(
      parseArguments([
        "--repo",
        "owner/repo",
        "--defaults",
        "--yes",
        "--dry-run",
      ]),
      {
        mode: "setup",
        dryRun: true,
        defaults: true,
        yes: true,
        repository: "owner/repo",
        scope: undefined,
        environment: undefined,
        secretName: undefined,
        ...ci,
      },
    );
  });

  it("parses an environment secret target", () => {
    assert.deepEqual(
      parseArguments([
        "secrets",
        "--environment",
        "production",
        "--name",
        "DATABASE_URL",
      ]),
      {
        mode: "secrets",
        dryRun: false,
        defaults: false,
        yes: false,
        repository: undefined,
        scope: undefined,
        environment: "production",
        secretName: "DATABASE_URL",
        ...ci,
      },
    );
  });

  it("rejects ambiguous and unsafe secret arguments", () => {
    assert.throws(
      () =>
        parseArguments([
          "secrets",
          "--scope",
          "repository",
          "--environment",
          "production",
          "--name",
          "TOKEN",
        ]),
      /either --scope or --environment/,
    );
    assert.throws(
      () => parseArguments(["secrets", "--environment", "production"]),
      /require --name/,
    );
    assert.throws(
      () => parseArguments(["secrets", "--defaults"]),
      /cannot be configured with --defaults/,
    );
  });
});

describe("repository settings", () => {
  it("builds the agreed merge and feature policy", () => {
    assert.deepEqual(buildRepositorySettings(), {
      default_branch: "main",
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      has_discussions: false,
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: false,
      allow_auto_merge: false,
      allow_update_branch: false,
      delete_branch_on_merge: true,
      merge_commit_title: "PR_TITLE",
      merge_commit_message: "BLANK",
      squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
      squash_merge_commit_message: "COMMIT_MESSAGES",
    });
  });

  it("adds only explicitly supplied metadata", () => {
    assert.equal(
      buildRepositorySettings({ description: "Example" }).description,
      "Example",
    );
  });
});

describe("Actions settings", () => {
  it("uses selected actions with a read-only default token that can open PRs", () => {
    const settings = buildActionsSettings({
      allowedActions: ["dorny/paths-filter@*"],
    });

    assert.deepEqual(settings.permissions, {
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: false,
    });
    assert.equal(settings.selectedActions.github_owned_allowed, true);
    assert.equal(settings.selectedActions.verified_allowed, false);
    assert.deepEqual(settings.selectedActions.patterns_allowed, [
      "dorny/paths-filter@*",
    ]);
    assert.deepEqual(settings.workflow, {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: true,
    });
  });

  it("allows each third-party action and reusable workflow once, at any ref", () => {
    const tests = `
jobs:
  call:
    uses: owner/shared/.github/workflows/ci.yml@v1
  build:
    steps:
      - uses: actions/checkout@v7
      - uses: "dorny/paths-filter@v4" # filter
      - name: Label
        uses: release-drafter/release-drafter/autolabeler@0123456789abcdef
      - uses: ./.github/actions/local
      - uses: docker://alpine:3
      - uses: github/codeql-action/init@v3
`;
    const labels = "      - uses: dorny/paths-filter@v3\n";

    assert.deepEqual(workflowActionPatterns([tests, labels]), [
      "dorny/paths-filter@*",
      "owner/shared/.github/workflows/ci.yml@*",
      "release-drafter/release-drafter/autolabeler@*",
    ]);
  });

  it("preserves an existing SHA pinning requirement", () => {
    assert.equal(
      buildActionsSettings({ shaPinningRequired: true }).permissions
        .sha_pinning_required,
      true,
    );
  });

  it("keeps artifacts and logs for 30 days within the organization cap", () => {
    assert.deepEqual(buildRetentionSettings(), { days: 30 });
    assert.deepEqual(buildRetentionSettings(90), { days: 30 });
    assert.deepEqual(buildRetentionSettings(14), { days: 14 });
  });

  it("keeps unused Actions caches for 3 days", () => {
    assert.deepEqual(buildCacheRetentionSettings(), {
      max_cache_retention_days: 3,
    });
  });

  it("keeps the cache retention an organization caps lower", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const calls = [];
    applyCacheRetention(
      "owner/repo",
      buildCacheRetentionSettings(),
      (method, endpoint, body) => {
        calls.push([method, endpoint, body]);
        throw httpError(400, "Bad Request");
      },
    );
    assert.deepEqual(calls, [
      [
        "PUT",
        "/repos/owner/repo/actions/cache/retention-limit",
        { max_cache_retention_days: 3 },
      ],
    ]);
    assert.match(warn.mock.calls[0].arguments[0], /may cap it/);
  });

  it("stops on other cache retention errors", () => {
    assert.throws(
      () =>
        applyCacheRetention("owner/repo", buildCacheRetentionSettings(), () => {
          throw httpError(500, "Server Error");
        }),
      /Server Error/,
    );
  });

  it("names the organization setting that blocks pull request creation", () => {
    const calls = [];
    const request = (method, endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith("/workflow")) throw httpError(409, "Conflict");
    };

    assert.throws(
      () => applyActionsSettings("owner/repo", buildActionsSettings(), request),
      /Allow GitHub Actions to create and approve pull requests/,
    );
    assert.deepEqual(calls, [
      "/repos/owner/repo/actions/permissions",
      "/repos/owner/repo/actions/permissions/selected-actions",
      "/repos/owner/repo/actions/permissions/workflow",
    ]);
  });

  it("propagates Actions failures that are not policy conflicts", () => {
    const request = () => {
      throw httpError(403, "Forbidden");
    };

    assert.throws(
      () => applyActionsSettings("owner/repo", buildActionsSettings(), request),
      /Forbidden/,
    );
  });
});

describe("security settings", () => {
  it("enables secret scanning with push protection", () => {
    assert.deepEqual(buildSecurityAndAnalysis(), {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    });
  });

  it("enables Dependabot alerts and leaves security updates opt-in", () => {
    assert.deepEqual(buildDependabotSettings(), {
      vulnerability_alerts: true,
      security_updates: false,
    });
    assert.equal(
      buildDependabotSettings({ securityUpdates: true }).security_updates,
      true,
    );
  });
});

describe("OpenCode workflow settings", () => {
  it("offers the model variables the workflow reads", () => {
    assert.deepEqual(MODEL_VARIABLES, [
      "OPENCODE_MODEL",
      "OPENCODE_MODEL_PLAN",
      "OPENCODE_MODEL_BUILD",
      "OPENCODE_MODEL_REVIEW",
      "OPENCODE_MODEL_DEBUG",
    ]);
  });

  it("offers the provider key secrets the workflow passes on", () => {
    assert.deepEqual(PROVIDER_SECRETS, [
      "OPENCODE_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });
});

describe("release deploy key", () => {
  const key = (read_only) => ({ id: 7, read_only });

  it("keeps a writable key whose secret is present", () => {
    assert.equal(planReleaseKey({ key: key(false), secret: true }), "keep");
  });

  it("creates a key pair when there is no key", () => {
    assert.equal(planReleaseKey({ key: undefined, secret: false }), "create");
    assert.equal(planReleaseKey({ key: undefined, secret: true }), "create");
  });

  it("replaces a key without its secret, or one that cannot push", () => {
    assert.equal(planReleaseKey({ key: key(false), secret: false }), "replace");
    assert.equal(planReleaseKey({ key: key(true), secret: true }), "replace");
  });

  it("is used only by a repository whose workflows read its secret", () => {
    const publish =
      "    secrets:\n      deploy-key: ${{ secrets.RELEASE_DEPLOY_KEY }}\n";

    assert.equal(usesReleaseKey(["on: push\n", publish]), true);
    assert.equal(usesReleaseKey(["on: push\n"]), false);
    assert.equal(
      usesReleaseKey(["key: ${{ secrets.RELEASE_DEPLOY_KEY_OLD }}\n"]),
      false,
    );
  });
});

describe("main protection", () => {
  it("builds an active main ruleset with the required CI gate", () => {
    const ruleset = buildMainRuleset(15368, { releaseKey: true });
    const pullRequestRule = ruleset.rules.find(
      (rule) => rule.type === "pull_request",
    );
    const statusRule = ruleset.rules.find(
      (rule) => rule.type === "required_status_checks",
    );

    assert.equal(ruleset.name, "Protect main");
    assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/main"]);
    assert.deepEqual(ruleset.bypass_actors, [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
    ]);
    assert.equal(pullRequestRule.parameters.required_approving_review_count, 0);
    assert.equal(
      pullRequestRule.parameters.required_review_thread_resolution,
      true,
    );
    assert.deepEqual(pullRequestRule.parameters.allowed_merge_methods, [
      "merge",
      "squash",
    ]);
    assert.deepEqual(statusRule.parameters.required_status_checks, [
      { context: "Required checks", integration_id: 15368 },
    ]);
    assert.equal(
      statusRule.parameters.strict_required_status_checks_policy,
      true,
    );
  });

  it("preserves stricter classic protection while adding the required check", () => {
    const protection = buildBranchProtection(
      {
        required_status_checks: {
          contexts: ["security"],
          checks: [{ context: "security", app_id: 42 }],
        },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
          required_approving_review_count: 2,
          require_last_push_approval: true,
        },
        required_linear_history: { enabled: true },
      },
      15368,
    );

    assert.deepEqual(protection.required_status_checks, {
      strict: true,
      contexts: ["security", "Required checks"],
      checks: [
        { context: "security", app_id: 42 },
        { context: "Required checks", app_id: 15368 },
      ],
    });
    assert.equal(protection.enforce_admins, true);
    assert.equal(
      protection.required_pull_request_reviews.required_approving_review_count,
      2,
    );
    assert.equal(protection.required_linear_history, true);
    assert.equal(protection.allow_force_pushes, false);
    assert.equal(protection.allow_deletions, false);
  });

  it("lets deploy keys bypass only for a repository that releases with one", () => {
    assert.deepEqual(buildMainRuleset(15368).bypass_actors, [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
  });

  it("requires the check a repository names instead", () => {
    const statusRule = buildMainRuleset(15368, {
      requiredCheck: "CI passed",
    }).rules.find((rule) => rule.type === "required_status_checks");

    assert.deepEqual(statusRule.parameters.required_status_checks, [
      { context: "CI passed", integration_id: 15368 },
    ]);
    assert.deepEqual(
      buildBranchProtection({}, 0, "CI passed").required_status_checks.contexts,
      ["CI passed"],
    );
  });
});

describe("diffObject", () => {
  it("returns only changed desired fields", () => {
    assert.deepEqual(
      diffObject(
        { enabled: true, mode: "all", untouched: 1 },
        {
          enabled: true,
          mode: "selected",
        },
      ),
      [{ key: "mode", current: "all", desired: "selected" }],
    );
  });
});

describe("normalizeSelectedActions", () => {
  it("reports no change when GitHub returns the patterns in another order", () => {
    const desired = buildActionsSettings({
      allowedActions: ["a/x@*", "b/y@*", "c/z@*"],
    }).selectedActions;
    const current = {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: ["c/z@*", "a/x@*", "b/y@*"],
    };
    assert.deepEqual(
      diffObject(normalizeSelectedActions(current), desired),
      [],
    );
    assert.deepEqual(current.patterns_allowed, ["c/z@*", "a/x@*", "b/y@*"]);
  });

  it("still reports a pattern that is missing", () => {
    const desired = buildActionsSettings({
      allowedActions: ["a/x@*", "b/y@*"],
    }).selectedActions;
    const diff = diffObject(
      normalizeSelectedActions({ patterns_allowed: ["b/y@*"] }),
      desired,
    );
    assert.deepEqual(
      diff.map(({ key }) => key),
      ["github_owned_allowed", "verified_allowed", "patterns_allowed"],
    );
  });

  it("leaves a state without patterns alone", () => {
    assert.deepEqual(normalizeSelectedActions({}), {});
  });
});
