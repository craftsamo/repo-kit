---
description: "Read-only deep review of one small, high-risk scope: checks whether the change breaks existing system assumptions such as ownership, lifecycle, permissions, caching, or data shape. Hand it one named candidate."
mode: subagent
# Prompt: OpenCode's built-in prompt plus instructions/ci-reviewer-deep.md,
# which plugins/instructions.ts adds. Keep this file's body empty.
# A subagent runs with its own permissions, not its parent's, so it carries
# the full read-only rule set of the CI agents.
# The OpenCode free tier rejects requests whose core tools (edit, shell, ...)
# were trimmed by deny rules, so those stay visible. Anything not allowed
# below resolves to ask, which a non-interactive run always rejects.
permissions:
  - { action: "*", resource: "*", effect: ask }
  # Code Mode can reach the network through fetch and ignores ask, so it is
  # removed, as is the desktop browser. The free tier accepts their absence.
  - { action: execute, resource: "*", effect: deny }
  - { action: browser, resource: "*", effect: deny }
  # Skills only add instructions to the context; any command they suggest
  # still goes through the shell rules below.
  - { action: skill, resource: "*", effect: allow }
  - { action: read, resource: "*", effect: allow }
  - { action: read, resource: "*.env", effect: ask }
  - { action: read, resource: "*.env.*", effect: ask }
  - { action: read, resource: "*.env.example", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: grep, resource: "*", effect: allow }
  - { action: shell, resource: "git log*", effect: allow }
  - { action: shell, resource: "git show*", effect: allow }
  - { action: shell, resource: "git blame*", effect: allow }
  - { action: shell, resource: "git status*", effect: allow }
  - { action: shell, resource: "git ls-files*", effect: allow }
  - { action: shell, resource: "git ls-tree*", effect: allow }
  - { action: shell, resource: "git rev-parse*", effect: allow }
  - { action: shell, resource: "git merge-base*", effect: allow }
  # Given two paths, git diff reads files outside the repository, so it is
  # only allowed against a pull request ref. The path rules below refuse the
  # outside paths that could still switch it to comparing files.
  - { action: shell, resource: "git diff refs/opencode/*", effect: allow }
  - { action: shell, resource: "git diff * refs/opencode/*", effect: allow }
  # Flags that write files or read outside the repository. "--con" also
  # covers the abbreviations git accepts for blame --contents.
  - { action: shell, resource: "git *--out*", effect: ask }
  - { action: shell, resource: "git *--no-index*", effect: ask }
  - { action: shell, resource: "git *--con*", effect: ask }
  - { action: shell, resource: "git *--ext-diff*", effect: ask }
  - { action: shell, resource: "git *--textconv*", effect: ask }
  # A path outside the repository makes git diff compare files directly, so
  # absolute, parent, and home paths, quoting, and expansions are refused.
  - { action: shell, resource: "git * /*", effect: ask }
  - { action: shell, resource: "git *=/*", effect: ask }
  - { action: shell, resource: "git *../*", effect: ask }
  - { action: shell, resource: "git * ~*", effect: ask }
  - { action: shell, resource: 'git *"*', effect: ask }
  - { action: shell, resource: "git *'*", effect: ask }
  - { action: shell, resource: "git *$*", effect: ask }
---
