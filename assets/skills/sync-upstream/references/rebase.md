# Rebase mode

Replay this fork's commits on top of the latest `upstream/main`. Rebasing
rewrites `main`, so every landing path ends in a force push: use this mode only
when step 2 of the skill found that no one else builds on `main`.

## 1. Backup (recovery point)

`git tag backup/pre-rebase-$(date +%Y%m%d-%H%M) main`
Undo anytime with `git reset --hard <tag>`.

## 2. Rebase

Preserve history by default — keep upstream's PR merge topology intact:

- `git rebase --rebase-merges upstream/main` ← default; recreates merge commits

Flatten ONLY when you have a deliberate, stated reason:

- `git rebase upstream/main` (plain rebase flattens PR merge commits into a
  linear sequence and discards the original merge topology — avoid unless intended).

## 3. Resolve conflicts — mind the ours/theirs SWAP

During rebase the sides are REVERSED vs a merge:

- `--ours` / `HEAD` = `upstream/main` (the new base) + already-replayed commits.
- `--theirs` = the fork commit currently being applied (your change).

Per conflict: reconcile `<<<<<<< ======= >>>>>>>`, then `git add` →
`git rebase --continue`. Use `git rebase --skip` if the commit is already in
upstream, `git rebase --abort` to bail to the backup. Never blanket `-X ours` /
`-X theirs` across the whole rebase.

## 4. Land

Decision rule: **bucket 1 only ∧ checks green ∧ audit clean → Path 1**,
otherwise **→ Path 2**.

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

## Anti-patterns

- Do NOT flatten upstream's merge commits by default — default to `--rebase-merges`
  to preserve the real topology; plain `git rebase` flattens, so flatten only on purpose.
- Do NOT confuse the rebase swap: `--ours` = upstream, `--theirs` = your fork commit.
- Do NOT skip the backup tag.
- Do NOT plain `git push --force` — use `--force-with-lease`.
- Do NOT force-push a red rebase to main — that's bucket 2/3 → Path 2.
