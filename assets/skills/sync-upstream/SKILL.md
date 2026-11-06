---
name: sync-upstream
description: |-
  Use when bringing upstream changes into this fork, or into a repository created from a template that has an `upstream` remote, and resolving the resulting conflicts (取り込む / リベース / 追従 / 同期 / 移植). Picks the mode from the history and how `main` is shared: merge through a pull request when other people work on `main` (nothing is force-pushed), rebase when only you push to it, or port upstream's changes commit by commit when the repository shares no history with upstream. Covers the ours/theirs sides of each mode, the three conflict buckets (textual / type-ripple / silent drift), a coupling audit for fork-only surfaces, verification, and landing. Trigger keywords: "upstream", "sync upstream", "sync fork", "merge upstream", "rebase", "force push", "merge conflict", "fork", "template", "cherry-pick", "取り込む", "リベース", "追従", "同期", "移植". Not for sending a change to upstream (open a pull request there) or deciding which layer of a fork chain a change belongs in (fork-layer-placement).
license: MIT
compatibility: opencode
metadata:
  category: workflow
  package: repo
  stack: git,fork-chain
---

<Goal>

Bring the latest `upstream/main` into this fork's `main` without breaking
anyone else's work: pick the mode that fits the history and who shares `main`,
classify what the sync touched (textual conflict vs. ripple vs. silent drift),
land it on the correct path, and keep a faithful, recoverable history the next
sync can build on.

</Goal>

<Scope>

- "Fork" covers a repository created from a template too: it tracks upstream
  the same way, though its history starts with its own first commit.
- Remotes: `origin` = this fork, `upstream` = the repo this fork tracks
  (`git remote get-url upstream`). Syncing always uses this git remote — not
  any read-only mirror your tooling may keep for browsing the upstream.
- Layer-agnostic: this fork may itself be the upstream of another fork. "upstream"
  always = whatever the git `upstream` remote points to. Each layer derives its
  own surfaces — do not hardcode app/package names.
- Fork-only surfaces = paths that exist ONLY in this fork (upstream never edits
  them, so git never conflicts them — this is where silent drift hides). Don't
  assume them; COMPUTE them for your layer after fetching:
  - fork-added files: `git diff --diff-filter=A --name-only upstream/main HEAD`
  - fork-modified shared: `git diff --diff-filter=M --name-only upstream/main HEAD`
- Verify with the repository's checks, the build, typecheck, lint and test
  commands its AGENTS.md names, so they cover fork-only code too.

</Scope>

<Steps>

### 1. Preflight

1. Clean tree — never sync a dirty tree: `git status` (stash/commit first).
2. Ensure the remote exists: `git remote get-url upstream` (else
   `git remote add upstream <url>`).
3. `git fetch origin && git fetch upstream`. In a shallow clone
   (`git rev-parse --is-shallow-repository` prints `true`), run
   `git fetch --unshallow origin` first: a shallow history hides the base.
4. `git switch main`. `git rev-list --count origin/main..main` must print `0`;
   otherwise local `main` holds commits `origin` does not, so find out why
   before syncing. Then `git merge --ff-only origin/main`.
5. Record the base: `BASE=$(git merge-base origin/main upstream/main)`. Empty
   means the two histories share no commit — step 2 picks port.
6. Preview (with a base):
   - incoming: `git log --oneline $BASE..upstream/main`
   - fork-only commits: `git log --oneline upstream/main..origin/main`
   - divergence: `git rev-list --left-right --count origin/main...upstream/main`
7. Name the fork for every `gh` command. With an `upstream` remote, `gh` may
   resolve the repository to upstream, so take it from `origin`:
   `REPO=$(git remote get-url origin | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')`,
   then pass it on: `gh api repos/$REPO/...`, `gh pr ... -R "$REPO"`.

### 2. Choose the mode

First the history: with no base (step 1), the repository was created from a
template or copied, and git can neither merge nor rebase it onto upstream →
**port**: [references/port.md](references/port.md). This holds after earlier
ports too, since porting never joins the histories. The rest of this step
applies only when there is a base.

Rebasing rewrites `main`: everyone else's clones, branches and open pull
requests built on it then point at commits that no longer exist. Rebase only a
`main` you are sure no one else builds on.

`main` is **shared** when any of these signals holds, or when you cannot
check one of them:

| Signal                                 | Check                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream was already synced by a merge | a merge on `main`'s first-parent line whose second parent upstream holds: for each `<merge> <p1> <p2>` of `git log --first-parent --merges --format='%h %p' $BASE..origin/main`, `git merge-base --is-ancestor <p2> upstream/main`                           |
| Someone else committed to `main`       | `git log --format='%ae' $BASE..origin/main \| sort -u` lists an address other than yours (`git config user.email`), bots aside                                                                                                                               |
| A pull request targets `main`          | `gh pr list -R "$REPO" --base main --state open` lists any, yours included — a rebase pulls its base out from under it                                                                                                                                       |
| Rules protect `main`                   | `gh api repos/$REPO/rules/branches/main --jq '.[].type'` lists `pull_request`, `non_fast_forward` or `required_linear_history`, or `gh api repos/$REPO/branches/main/protection` answers (404, or a 403 saying the plan lacks branch protection, means none) |
| Other people can push                  | the owner is an organization, or `gh api repos/$REPO/collaborators --jq '.[].login'` lists a login other than yours (`gh api user --jq .login`)                                                                                                              |
| Others build on the fork               | `gh api repos/$REPO --jq .forks_count` is more than 0: forks of this fork rebase or merge onto its `main`                                                                                                                                                    |

Signals only show who can be seen. Before a rebase, also ask the user to
confirm that nobody else builds on `main`, such as a clone or a deployment you
cannot see.

Pick the mode and report it with the signals that decided it:

- `main` is shared → **merge**: [references/merge.md](references/merge.md).
- Every signal was checked and none holds → **rebase**:
  [references/rebase.md](references/rebase.md).

An explicit choice from the user wins over the signals — a shared `main` is
never rebased without one — with two exceptions: a repository without a base
can only be ported, and once `main` holds an upstream merge, stay on merge,
since rebasing would rewrite history others already have.

### 3. Sync

Follow the chosen reference up to its landing step. The conflict sides depend
on the mode:

| Mode   | `--ours` / `HEAD`                              | `--theirs`                              | Back out                  |
| ------ | ---------------------------------------------- | --------------------------------------- | ------------------------- |
| merge  | this fork (the sync branch cut from `main`)    | upstream                                | `git merge --abort`       |
| rebase | `upstream/main` + the already-replayed commits | the fork commit being replayed          | `git rebase --abort`      |
| port   | this repository (the sync branch)              | the upstream commit being cherry-picked | `git cherry-pick --abort` |

Never blanket `-X ours` / `-X theirs` across a whole sync.

### 4. Classify — the three buckets (this decides the landing path)

| Bucket                   | What                                                                                                                                                     | Detect with                                         | Handled by                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| 1. Textual conflict      | overlapping edits (`<<<<<<<`)                                                                                                                            | git marks them during the sync                      | resolving the conflict             |
| 2. Type/behaviour ripple | clean apply, but types/build/tests break                                                                                                                 | the repository's typecheck, build and test commands | a fix commit — where, per the mode |
| 3. Silent drift          | clean apply, checks green, but a fork-only surface is stale (e.g. a fork-only doc section, or an env var the fork introduced that upstream just renamed) | coupling audit (step 5) + review                    | a follow-up PR                     |

Conflict vs. follow-up: if git put a marker on it → conflict resolution
(reconcile the overlapping lines, add NO new behavior). If it applied cleanly but
is now inconsistent → follow-up implementation. Do NOT fold follow-up work into a
conflict-resolution commit.

### 5. Coupling audit (bucket 3 — the checks cannot see this)

1. Compute YOUR fork-only surfaces (don't hardcode):
   `FORK_ONLY=$(git diff --diff-filter=A --name-only upstream/main HEAD)`
2. What upstream changed in shared coupling surfaces:
   `git diff $BASE..upstream/main --stat` # shared packages, configs, env, docs
   (port: `$SYNC..$TARGET`, see its reference)
3. For each changed shared symbol/convention (a shared type/constant shape, an env
   var name, a doc convention), grep your fork-only surfaces for stale refs:
   `git grep -n "<symbol-or-name>" -- $FORK_ONLY`
4. Compiles green but now inconsistent (stale docs, old env name, outdated contract
   impl) = bucket 3 → schedule a follow-up PR.

Semi-mechanical: diff + grep + judgment. The checks never flag prose/semantic/
runtime-string drift.

### 6. Land

Follow the chosen reference's landing step: the buckets decide the path.

</Steps>

<Verify>

- The repository's build, lint, typecheck and test commands — green clears
  bucket 2.
- Run the coupling audit (step 5) even when green — bucket 3 is invisible to
  the checks.
- After landing, `git fetch origin` and
  `git merge-base origin/main upstream/main` is the upstream commit you synced
  to, so the next sync starts from there. After a port, the landing commit
  carries `Upstream-Synced-To:` with that commit instead.

</Verify>

<AntiPatterns>

- Do NOT rebase or force-push a shared `main` — merge through a pull request.
- Do NOT `git pull` upstream into `main`, or merge it locally and push `main`:
  a merge sync lands only through its pull request.
- Do NOT switch a fork that has synced by merge back to rebase.
- Do NOT `git merge --allow-unrelated-histories` a repository without a base —
  port it.
- Do NOT squash- or rebase-merge a merge-mode sync pull request — both turn
  upstream's commits into new ones, and the next sync conflicts with the same
  changes again. (A port has no shared history to lose; see its reference.)
- Do NOT blanket `-X ours` / `-X theirs` an entire sync.
- Do NOT sync a dirty tree.
- Checks green ≠ done — always run the coupling audit for fork-only drift (bucket 3).
- Do NOT fold follow-up implementation into a conflict-resolution commit.
- Do NOT hardcode fork-only paths — compute them (`git diff --diff-filter=A`).

</AntiPatterns>
