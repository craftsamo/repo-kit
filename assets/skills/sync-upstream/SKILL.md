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

### 2. Sync

Follow [references/rebase.md](references/rebase.md) steps 1–3: the backup
tag, the rebase, and its conflicts, where the ours/theirs sides are swapped.

### 3. Classify — the three buckets (this decides the landing path)

| Bucket                   | What                                                                                                                                                     | Detect with                                         | Path           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| 1. Textual conflict      | overlapping edits (`<<<<<<<`)                                                                                                                            | git marks them during rebase                        | resolve inline |
| 2. Type/behaviour ripple | clean apply, but types/build/tests break                                                                                                                 | the repository's typecheck, build and test commands | follow-up PR   |
| 3. Silent drift          | clean apply, checks green, but a fork-only surface is stale (e.g. a fork-only doc section, or an env var the fork introduced that upstream just renamed) | coupling audit (step 4) + review                    | follow-up PR   |

Conflict vs. follow-up: if git put a marker on it → conflict resolution
(reconcile the overlapping lines, add NO new behavior). If it applied cleanly but
is now inconsistent → follow-up implementation. Do NOT fold follow-up work into a
conflict-resolution commit.

### 4. Coupling audit (bucket 3 — the checks cannot see this)

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

### 5. Land

Follow [references/rebase.md](references/rebase.md) step 4: the buckets pick
Path 1 (direct to main) or Path 2 (follow-up PR).

</Steps>

<Verify>

- The repository's build, lint, typecheck and test commands — green clears
  bucket 2.
- Run the coupling audit (step 4) even when green — bucket 3 is invisible to
  the checks.

</Verify>

<AntiPatterns>

- Do NOT `git pull` on main — it creates a merge; this flow is rebase-only.
- Do NOT blanket `-X ours` / `-X theirs` an entire rebase.
- Do NOT rebase a dirty tree.
- Checks green ≠ done — always run the coupling audit for fork-only drift (bucket 3).
- Do NOT fold follow-up implementation into a conflict-resolution commit.
- Do NOT hardcode fork-only paths — compute them (`git diff --diff-filter=A`).

</AntiPatterns>
