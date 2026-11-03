# Security policy

repo-kit changes repository settings, sets secrets and deploy keys, and runs
AI agents that can push to a repository. A flaw in it can reach every
repository that uses it, so please report one privately.

## Supported versions

Fixes go into the latest release of the current major version, and the major
tag (such as `v1`) moves to it. Callers pinned to the major tag get the fix
with their next run; callers pinned to an exact release need to move to the
new one.

## Reporting a vulnerability

Report it through
[GitHub Security Advisories](https://github.com/craftsamo/repo-kit/security/advisories/new).
Do not open a public issue or pull request for it. repo-kit has no bug bounty.

A useful report says:

- what an attacker can do, and what they need to do it
- the command or workflow affected, and the file and lines where it goes wrong
- the version (`repo-kit --version`, or the tag a workflow is pinned to)
- the steps to reproduce it against the latest release

## What repo-kit trusts

- **The CLI runs as you.** Every command reaches GitHub through `gh`,
  authenticated as the person running it, and can do no more than that
  account may. `setup secrets` hands each value to `gh secret set`, so the
  value never passes through repo-kit.
- **A reusable workflow runs with what its caller grants.** Each job keeps
  only the permissions it needs of those the calling job grants, and receives
  only the secrets passed to it by name. It uses GitHub-owned actions only and
  runs repo-kit at the commit of the tag the caller pinned.
- **`/oc` runs for the people the repository trusts.** Only an owner, member
  or collaborator can start an agent. `build` never pushes workflow files or
  to a fork, and an agent stops when the tree it runs in configures an agent
  with the id of a CI agent, since that could widen its permissions. Secret
  values are removed from an agent's answer before it is posted.

## Scope

In scope:

- A command or workflow doing more than the permissions or secrets it was
  given allow, or more than the documentation says it does.
- Someone who is not an owner, member or collaborator starting an `/oc`
  agent, or steering one into acting beyond its documented limits, such as
  pushing a workflow file.
- A secret, token or deploy key leaking into a log, a comment, a commit or an
  artifact.
- `agents sync` replacing or removing a file it did not generate.

Out of scope:

- What an agent does within its permissions when a trusted person asked for
  it, including changes it proposes that are wrong. Review its pull requests
  as you would anyone's.
- Workflows pinned to a branch such as `main` instead of a release tag.
- Flaws in GitHub, the GitHub CLI, OpenCode, npm or a model provider; report
  those to their maintainers.

Hardening ideas that are not vulnerabilities are welcome as ordinary issues.

## Disclosure

We aim to confirm a report within a week, keep you informed in the advisory,
and publish the advisory once a fixed release is out. Reporters are credited in
it unless they ask not to be.
