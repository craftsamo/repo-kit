# Port mode

For a repository whose history does not contain upstream's — typically one
created from a template, whose first commit is its own. Git can neither merge
nor rebase across unrelated histories, so each upstream change comes in as a
new commit of this repository, made from upstream's commit and pointing back
at it. Each sync records how far it got, because git cannot work that out.

## 1. Find the sync point

Each sync leaves an `Upstream-Synced-To: <full sha>` trailer on the commit that
lands it (step 6), on `main`'s first-parent line. The newest one is where this
sync starts:

```sh
SYNC=$(git log --first-parent origin/main --format='%(trailers:key=Upstream-Synced-To,valueonly)' | grep -m1 .)
git merge-base --is-ancestor "$SYNC" upstream/main
```

If the second command fails, upstream rewrote its history and the recorded
commit is gone from it: stop and ask the user.

No trailer yet (the first sync, or earlier syncs made without one): do not
guess from dates alone. Look for an earlier sync pull request that names the
upstream commit it reached. Otherwise, for a repository made from a template,
find the upstream commit whose tree is closest to this repository's first
commit (`git rev-list --max-parents=0 origin/main`): start from the last
upstream commit before that commit's date and compare candidates with
`git diff --stat <candidate> <first commit>`. Confirm the result with the user
before going on.

## 2. List what is incoming

```sh
TARGET=$(git rev-parse upstream/main)
git log --first-parent --reverse --format='%h %s' $SYNC..$TARGET
```

Each first-parent commit is usually one upstream pull request (its merge
commit, or its squashed commit). Decide each one:

| Decision     | When                                                                           | Then                                                                                |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Take         | the change applies to this repository                                          | port it (step 3)                                                                    |
| Already here | this repository made the same change earlier, perhaps written differently      | port it anyway when matching upstream's form shrinks the difference, else record it |
| Skip         | it only matters upstream: the template's own setup, branding, releases, its CI | record it with the reason                                                           |

Ask the user when a decision is unclear, such as a change that undoes a choice
this repository made on purpose. Keep all three lists for the pull request.

## 3. Port each change

```sh
git switch -c sync/upstream-$(date +%Y%m%d) origin/main
```

For each change to take, in upstream's order, make one commit:

- a merge commit: `git cherry-pick -m 1 <sha>`, which applies the whole
  upstream pull request at once;
- a single commit: `git cherry-pick <sha>`.

Then `git commit --amend` to word the message in this repository's commit
convention and end the body with where it came from:

```text
upstream: <short sha> (<owner>/<repo>#<pr>)
```

`<owner>/<repo>#<pr>` is the pull request that made the change. When upstream
itself took the change from its own upstream, follow it to the repository
where it was first made, so the link leads to the original discussion. Drop
any `Upstream-Synced-To:` line the upstream message carries: it records
upstream's own sync, and step 1 would mistake it for this repository's.

The sides of a cherry-pick: `--ours` / `HEAD` = this repository, `--theirs` =
the upstream commit being ported. Per conflict: reconcile, `git add`,
`git cherry-pick --continue`; `git cherry-pick --skip` when the change turns
out to be here already; `git cherry-pick --abort` to stop. Regenerate a
lockfile with the package manager instead of resolving it by hand.

When a change does not apply because the code around it differs too much,
port it by hand: make the same change in this repository's code, with the
same message and `upstream:` line, and say in the body that it was ported by
hand.

## 4. Adapt in separate commits

What this repository needs because of a port — a test that read a file a port
removes, a fork-only document that names a removed command — is its own
commit, never folded into a ported one, so every ported commit stays
comparable with upstream's. Order the commits so each passes the checks on its
own: an adaptation that drops a dependency on something a port removes comes
before that port. On the unpublished sync branch,
`git rebase --exec '<check command>' origin/main` runs the checks at every
commit.

## 5. Audit what is still different

`git diff --stat $TARGET HEAD` should show only fork-only surfaces and the
changes you recorded as skipped. Anything else is an incomplete port. Run the
coupling audit of the skill with the range `$SYNC..$TARGET` in place of
`$BASE..upstream/main`.

## 6. Open the pull request and land

The pull request body names the range `$SYNC..$TARGET`; the three lists
(taken, with each upstream pull request; already here; skipped, with the
reasons); the adaptations; how conflicts were resolved; and the differences
that remain. It ends with the line the landing commit will carry:

```text
Upstream-Synced-To: <full TARGET sha>
```

Land with a merge commit whose message ends with that trailer:
`gh pr merge -R "$REPO" --merge --body "<summary>"` (`$REPO` as step 1 of the
skill names it) with the trailer as the last line of
the body. When `main` accepts no merge commit, ask the user: with a rebase
merge the trailer goes on the last commit of the branch, with a squash merge
into the squash commit's message, and step 1 finds it either way.

## Anti-patterns

- Do NOT `git merge --allow-unrelated-histories` upstream — it brings in
  upstream's whole history as new commits and conflicts on every shared file.
- Do NOT port without an `upstream:` line, or land without the
  `Upstream-Synced-To:` trailer — the next sync could not tell where to start.
- Do NOT fold an adaptation into a ported commit.
- Do NOT confuse the sides: in a cherry-pick, `--ours` = this repository,
  `--theirs` = upstream — the opposite of a rebase.
