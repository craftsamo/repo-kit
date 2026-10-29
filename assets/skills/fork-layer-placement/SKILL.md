---
name: fork-layer-placement
description: |-
  Use when deciding WHICH repo/layer of a fork chain a shared change should live in — a new opencode skill, a shared package, a CI workflow, a convention, or a config ("upstream or fork?", "which layer?", "どっちに実装?", "どこに置く?"). Covers building the fork-lineage tree, the owns-it + common-ancestor rule, generic-to-root vs tech-to-its-layer, sibling forks, repo vs global, and the no-duplicate / no-delete-commit migration rule. Trigger keywords: "which repo", "which layer", "where to put", "upstream or fork", "fork chain", "placement", "どっちに実装", "どこに置く".
license: MIT
compatibility: opencode
metadata:
  category: workflow
  package: repo
  stack: git,monorepo,fork-chain
---

<Goal>

Decide which repo/layer of a fork chain a SHARED change should originate in, so it
reaches every fork that needs it without duplication or sync conflicts.

</Goal>

<Scope>

- Applies to **shared changes**: opencode skills, shared packages, CI/workflows,
  conventions, configs — anything multiple forks might inherit.
- NOT app features / layer-specific code: those live in whatever fork uses them
  (placement is obvious — don't over-hoist).
- A "fork chain" = repos linked by `upstream` remotes: a root (no upstream), its
  direct forks, their forks, and sibling forks that share a parent.
- Pairs with `sync-upstream`: this decides where to ORIGINATE a change;
  `sync-upstream` PROPAGATES it downward.

</Scope>

<Steps>

1. **Build the lineage tree.** For each repo: `git remote get-url upstream` (the
   root has none). Sketch parent → child and note siblings (forks sharing a
   parent).
2. **Classify what the change depends on.**
   - Generic / tech-agnostic, every fork could use it → root-ward.
   - Tied to a capability introduced at layer N (only N + descendants have it) →
     layer N.
   - Personal / machine-specific, not project-shared → a user-level (global)
     scope, outside the shared repos.
3. **Target layer = the shallowest layer that BOTH (a) owns/contains what the
   change depends on AND (b) is a common ancestor of every repo that needs it.**
   If the needers include a sibling that branches higher, go up to their common
   ancestor.
4. **Repo vs global.** Shared & versioned with the chain → the target repo. Pure
   personal cross-repo tooling with no dependency on any repo's code → a
   user-level (global) scope.
5. **Place it once, let it propagate.** Add it at the target layer; descendants
   inherit via `sync-upstream`. Do not copy it into multiple layers.

Worked examples:

- A generic, tech-agnostic procedure every fork needs (e.g. a fork-sync rebase
  guide) → the root, since every fork — including siblings — descends from it.
- A skill for a capability introduced one layer down (e.g. a deploy target only
  some forks add) → that layer; descendants inherit it, while the root and
  siblings that lack the capability don't carry it.

</Steps>

<Verify>

Before implementing, confirm the chosen layer:

- **Owns it**: the layer actually introduces/contains what the change depends on.
- **Covers all needers**: every repo that needs it is the chosen layer or
  downstream of it (check siblings!).
- **No duplication**: it doesn't already exist at another layer (would cause
  add/add sync conflicts).
- **Right sharing tier**: repo (shared/versioned) vs global (personal) matches the
  audience.

</Verify>

<AntiPatterns>

- Placing a generic, every-fork capability in a mid-chain layer — siblings that
  branch higher won't inherit it (the sibling-fork trap).
- Duplicating the same file across layers — guarantees add/add conflicts on every
  sync.
- "Moving" something with a delete-commit in a fork — on the next rebase the
  delete removes the inherited copy. Instead add at the correct layer and let the
  redundant copy reconcile via `git rebase --skip` (see `sync-upstream`).
- Putting layer-specific tooling at the generic root — dead weight there,
  irrelevant to siblings that lack the capability.
- Treating app features as "shared" — they belong in the fork that uses them.
- Reaching for global when forks/collaborators need it (or repo when it's purely
  personal cross-chain tooling) — match the tier to the audience.

</AntiPatterns>
