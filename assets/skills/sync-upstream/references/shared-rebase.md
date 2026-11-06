# Coordinated rebase of a shared `main`

Read only when step 2 of the skill found `main` shared and the user still
explicitly wants a rebase, for example to keep the fork's changes a linear
patch stack on top of upstream. Rebasing a shared `main` leaves every clone,
branch and open pull request built on it on commits that no longer exist. This
procedure makes that recoverable for everyone.

## Preconditions — stop and ask when one fails

- `main` holds no upstream merge (the first signal of step 2). Once it does,
  stay on merge.
- `main` takes a direct force push (`$REPO` is the fork, as step 1 names it):
  `gh api repos/$REPO/rules/branches/main --jq '.[].type'` lists none of
  `non_fast_forward`, `pull_request` or `update`, and the classic protection
  (`gh api repos/$REPO/branches/main/protection`, 404 = none) neither leaves
  `allow_force_pushes` disabled nor requires pull request reviews — unless the
  user can bypass them. Otherwise the final push is rejected after the freeze
  was announced. Never lift a protection yourself: the user decides, and an
  administrator changes it.
- Everyone who works on `main` agreed and knows when it happens. You cannot
  check this: ask the user to confirm it.

## 1. Announce and freeze

1. Record where `main` is now: `OLD_MAIN=$(git rev-parse origin/main)`.
2. Collect what the rewrite affects: the open pull requests into `main`
   (`gh pr list -R "$REPO" --base main --state open --json number,headRefName,author`)
   and the other remote branches (`git branch -r`), which are likely built on
   it.
3. Draft the announcement from the first template below for the user to send:
   `main` will be rewritten, push your work before it starts, and merge
   nothing into `main` until the all-clear.
4. Merge nothing into `main` during the window.

## 2. Rebase with a shared backup

Follow [rebase.md](rebase.md), with two changes:

- Push the backup tag, so everyone can name the old `main` after the rewrite:
  `git push origin backup/pre-rebase-<stamp>`.
- Pin every force push of `main` to `OLD_MAIN`, so it refuses if someone
  merged during the window. It replaces the `git push --force-with-lease` of
  Path 1 and Path 2-b:
  `git push --force-with-lease=main:$OLD_MAIN origin main`.

Path 2-b's pull request is the review gate as usual.

## 3. Let everyone recover

Draft the second template below for the user to send. Each member:

1. Commits or stashes their changes: `git status --short` prints nothing.
   `git reset --hard` below discards uncommitted work.
2. Checks that their local `main` holds nothing unpushed:
   `git fetch origin --tags` and
   `git log --oneline backup/pre-rebase-<stamp>..main` prints nothing. When it
   prints commits, move them to a branch first.
3. Resets `main`: `git switch main && git reset --hard origin/main`.
4. Moves each branch built on the old `main` onto the new one, taking only
   the branch's own commits:
   `git rebase --onto origin/main backup/pre-rebase-<stamp> <branch>`, then
   `git push --force-with-lease origin <branch>` when it backs a pull request.

## 4. Close the window

- Check that each open pull request into `main` shows only its own commits.
- Draft the all-clear for the user to send.
- Once everyone has recovered, delete the backup tag from origin
  (`git push origin :refs/tags/backup/pre-rebase-<stamp>`); keep the local one.

## Templates

Before:

```text
main will be rebased onto upstream on <date> at <time>, rewriting its history.
Please push your work before then and merge nothing into main until the
all-clear. Affected pull requests: <list>.
```

After:

```text
main has been rebased onto upstream. The old main is the tag
backup/pre-rebase-<stamp>. To recover:

  git status --short                                  # must print nothing; commit or stash first
  git fetch origin --tags
  git log --oneline backup/pre-rebase-<stamp>..main   # must print nothing
  git switch main && git reset --hard origin/main
  git rebase --onto origin/main backup/pre-rebase-<stamp> <your-branch>
  git push --force-with-lease origin <your-branch>    # if it has a pull request
```
