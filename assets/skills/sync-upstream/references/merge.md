# Merge mode

Merge `upstream/main` into a sync branch and land it on `main` through a pull
request with a merge commit. Nothing on `main` is rewritten, so the people who
work on it keep their clones, branches and pull requests as they are; they
pick the sync up with an ordinary pull. The cost: the fork's own commits are
no longer a linear patch stack on top of upstream, and the fork stays on merge
from then on.

## 1. Check that the sync can land

Before doing any work, confirm `main` accepts a merge commit (`$REPO` is the
fork, as step 1 of the skill names it):

- Merge commits are allowed: `gh api repos/$REPO --jq .allow_merge_commit` is
  `true`. `null` means you cannot see the setting: ask.
- No rule requires linear history:
  `gh api repos/$REPO/rules/branches/main --jq '.[].type'` does not list
  `required_linear_history`, and
  `gh api repos/$REPO/branches/main/protection --jq .required_linear_history.enabled`
  is not `true` (404 = no protection).
- No rule limits the merge method:
  `gh api repos/$REPO/rules/branches/main --jq '.[] | select(.type == "pull_request") | .parameters.allowed_merge_methods'`
  is empty or includes `merge`.

If either fails, STOP and ask the user. The ways forward are theirs to pick:
change the setting or rule that failed — allow merge commits, or lift the
linear-history or merge-method rule for sync pull requests (a ruleset bypass
can do this) — or rebase `main` with everyone's agreement
([shared-rebase.md](shared-rebase.md)), which needs force pushes to `main`
allowed instead. Do not land the sync as a squash or rebase merge to get
around the rule: both turn upstream's commits into new ones, so `main` loses
its common history with upstream and every later sync conflicts with the same
changes again.

## 2. Merge into a sync branch

```sh
UPSTREAM=$(git rev-parse upstream/main)
git switch -c sync/upstream-$(date +%Y%m%d) origin/main
git merge --no-ff -m "<message>" "$UPSTREAM"
```

Merge the recorded commit, not the moving `upstream/main`, so the pull request
brings in exactly what you reviewed. Write the message in the repository's
commit convention, naming the upstream commit
(`git rev-parse --short $UPSTREAM`).

A long gap (`git log --first-parent --oneline $BASE..$UPSTREAM` runs to many
upstream pull requests) is easier to review in steps: merge older points of
upstream's first-parent line first, one merge commit each, on the same branch.
Each step's conflicts are then resolved and reviewed on their own.

## 3. Resolve conflicts

In a merge the sides are NOT swapped: `--ours` / `HEAD` = this fork,
`--theirs` = upstream. Per conflict: reconcile `<<<<<<< ======= >>>>>>>`, then
`git add`; when every file is resolved, `git commit` concludes the merge with
its message. `git merge --abort` returns to before the merge.

The resolution belongs in the merge commit and adds no new behavior. A file
upstream deleted that the fork changed (modify/delete) is a decision, not a
merge mechanic: keep or drop it deliberately and say why in the pull request.

## 4. Fix ripples on the same branch

`main` must stay green when the pull request lands, so bucket 2 cannot wait:
fix it on the sync branch, in commits after the merge commit, one concern each.
Bucket 3 goes to a follow-up pull request on top of the synced `main`.

## 5. Open the pull request

Push the branch to `origin` and open a pull request into the fork's `main`
(`gh pr create -R "$REPO" --base main`), following the repository's pull
request convention. The body names:

- the upstream range, `$BASE..$UPSTREAM`, and the upstream pull requests it
  brings in (`git log --first-parent --oneline $BASE..$UPSTREAM`);
- how each conflict was resolved;
- the ripple fixes on the branch, and the follow-ups scheduled for bucket 3.

## 6. Land

Land with a merge commit: `gh pr merge -R "$REPO" --merge`, or the button's "Create a
merge commit". When `main` moves while the pull request is open, bring it in
with `git merge origin/main` on the sync branch — never rebase the sync branch,
which would copy upstream's commits into new ones. When upstream moves, land
this sync and start the next one, or merge the newer upstream commit into the
same branch.

The rest of the team runs `git pull` on `main` as usual; nobody has anything
to recover.

## Anti-patterns

- Do NOT confuse the sides: in a merge, `--ours` = this fork, `--theirs` =
  upstream — the opposite of a rebase.
- Do NOT squash- or rebase-merge the sync pull request, and do NOT rebase the
  sync branch.
- Do NOT work around a linear-history or merge-method rule — stop and ask.
- Do NOT merge into local `main` and push it; land through the pull request.
