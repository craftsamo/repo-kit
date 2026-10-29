---
name: sync-upstream
description: |-
  Use when incorporating upstream changes into this fork via git rebase and resolving the resulting conflicts (取り込む / リベース / 追従). Covers fetch upstream, a backup tag, the rebase ours/theirs swap, the three conflict buckets (textual / type-ripple / silent drift), a coupling audit for fork-only surfaces, verification with the repository's checks, and the two landing paths (direct-to-main vs follow-up PR). Trigger keywords: "upstream", "rebase", "sync upstream", "merge conflict", "fork", "取り込む", "リベース", "追従".
license: MIT
compatibility: opencode
metadata:
  category: workflow
  package: repo
  stack: git,fork-chain
---

<Goal>

Replay this fork's commits on top of the latest `upstream/main`, classify what
the sync touched (textual conflict vs. ripple vs. silent drift), resolve/land it
on the correct path, and preserve a faithful, recoverable history — keep
upstream's merge topology intact rather than flattening it.

</Goal>

<Scope>

- Remotes: `origin` = this fork, `upstream` = the repo this fork tracks
  (`git remote get-url upstream`). Rebase always uses this git remote — not any
  read-only mirror your tooling may keep for browsing the upstream.
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

1. Clean tree — never rebase a dirty tree: `git status` (stash/commit first).
2. Ensure the remote exists: `git remote get-url upstream` (else
   `git remote add upstream <url>`).
3. `git switch main`.
4. `git fetch upstream`.
5. Record the base: `BASE=$(git merge-base HEAD upstream/main)`.
6. Preview:
   - incoming: `git log --oneline $BASE..upstream/main`
   - replayed: `git log --oneline upstream/main..HEAD`
   - divergence: `git rev-list --left-right --count HEAD...upstream/main`

### 2. Backup (recovery point)

`git tag backup/pre-rebase-$(date +%Y%m%d-%H%M) main`
Undo anytime with `git reset --hard <tag>`.

### 3. Rebase

Preserve history by default — keep upstream's PR merge topology intact:

- `git rebase --rebase-merges upstream/main` ← default; recreates merge commits

Flatten ONLY when you have a deliberate, stated reason:

- `git rebase upstream/main` (plain rebase flattens PR merge commits into a
  linear sequence and discards the original merge topology — avoid unless intended).

### 4. Resolve conflicts — mind the ours/theirs SWAP

During rebase the sides are REVERSED vs a merge:

- `--ours` / `HEAD` = `upstream/main` (the new base) + already-replayed commits.
- `--theirs` = the fork commit currently being applied (your change).

Per conflict: reconcile `<<<<<<< ======= >>>>>>>`, then `git add` →
`git rebase --continue`. Use `git rebase --skip` if the commit is already in
upstream, `git rebase --abort` to bail to the backup. Never blanket `-X ours` /
`-X theirs` across the whole rebase.

### 5. Classify — the three buckets (this decides the landing path)

| Bucket                   | What                                                                                                                                                     | Detect with                                         | Path           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| 1. Textual conflict      | overlapping edits (`<<<<<<<`)                                                                                                                            | git marks them during rebase                        | resolve inline |
| 2. Type/behaviour ripple | clean apply, but types/build/tests break                                                                                                                 | the repository's typecheck, build and test commands | follow-up PR   |
| 3. Silent drift          | clean apply, checks green, but a fork-only surface is stale (e.g. a fork-only doc section, or an env var the fork introduced that upstream just renamed) | coupling audit (step 6) + review                    | follow-up PR   |

Decision rule: **bucket 1 only ∧ checks green ∧ audit clean → Path 1**, otherwise
**→ Path 2**.

Conflict vs. follow-up: if git put a marker on it → conflict resolution
(reconcile the overlapping lines, add NO new behavior). If it applied cleanly but
is now inconsistent → follow-up implementation. Do NOT fold follow-up work into a
conflict-resolution commit.

### 6. Coupling audit (bucket 3 — the checks cannot see this)

1. Compute YOUR fork-only surfaces (don't hardcode):
   `FORK_ONLY=$(git diff --diff-filter=A --name-only upstream/main HEAD)`
2. What upstream changed in shared coupling surfaces:
   `git diff $BASE..upstream/main --stat` # shared packages, configs, env, docs
3. For each changed shared symbol/convention (a shared type/constant shape, an env
   var name, a doc convention), grep your fork-only surfaces for stale refs:
   `git grep -n "<symbol-or-name>" -- $FORK_ONLY`
4. Compiles green but now inconsistent (stale docs, old env name, outdated contract
   impl) = bucket 3 → schedule a follow-up PR.

Semi-mechanical: diff + grep + judgment. The checks never flag prose/semantic/
runtime-string drift.

### 7. Land

**Path 1 — direct to main (sync only).** Bucket 1 only, checks green, audit clean:
`git push --force-with-lease origin main`
(rebase rewrote your commits → force is required; `--force-with-lease` refuses if
origin moved; the backup tag is your undo.)

**Path 2 — follow-up needed (PR).** Bucket 2/3 present:

- 2-a (preferred, when the rebase itself is green): land the clean rebase via
  Path 1 first, then do the adaptation as a NORMAL branch → PR → review/CI → merge
  on top of the synced main (no force-push).
- 2-b (when the rebase is red until adapted): keep rebase + adaptation together on
  `sync/upstream-<date>`, get it green, push the branch, open a PR for review/CI,
  then land with
  `git switch main && git reset --hard sync/upstream-<date> && git push --force-with-lease`
  (preserves the rebased topology and adds no extra merge commit; the PR is the
  review gate). Avoid GitHub squash-merge here — it pushes main off the
  "upstream + patches" line, discards history, and complicates the next rebase.

</Steps>

<Verify>

- The repository's build, lint, typecheck and test commands — green clears
  bucket 2.
- Run the coupling audit (step 6) even when green — bucket 3 is invisible to
  the checks.

</Verify>

<AntiPatterns>

- Do NOT `git pull` on main — it creates a merge; this flow is rebase-only.
- Do NOT flatten upstream's merge commits by default — default to `--rebase-merges`
  to preserve the real topology; plain `git rebase` flattens, so flatten only on purpose.
- Do NOT confuse the rebase swap: `--ours` = upstream, `--theirs` = your fork commit.
- Do NOT blanket `-X ours` / `-X theirs` an entire rebase.
- Do NOT rebase a dirty tree, and do NOT skip the backup tag.
- Do NOT plain `git push --force` — use `--force-with-lease`.
- Do NOT force-push a red rebase to main — that's bucket 2/3 → Path 2.
- Checks green ≠ done — always run the coupling audit for fork-only drift (bucket 3).
- Do NOT fold follow-up implementation into a conflict-resolution commit.
- Do NOT hardcode fork-only paths — compute them (`git diff --diff-filter=A`).

</AntiPatterns>
