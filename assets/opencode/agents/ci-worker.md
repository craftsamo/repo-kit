---
description: "Implementation worker for build: applies well-specified, mechanical edits in the working tree exactly as instructed, without design decisions. Hand it an exact spec: the files and the change to make in each."
mode: subagent
# Prompt: OpenCode's built-in prompt plus instructions/ci-worker.md, which
# plugins/instructions.ts adds. Keep this file's body empty.
# A subagent runs with its own permissions, not its parent's, so it carries
# build's rule set. Only build may launch it: build works in a separate clone,
# while the other agents run in the checkout the later workflow steps use.
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
  # Edits stay inside the working tree; paths outside it fall back to ask.
  # GITHUB_TOKEN cannot push workflow files, so those are refused up front.
  - { action: edit, resource: "*", effect: allow }
  - { action: edit, resource: "*.env", effect: ask }
  - { action: edit, resource: "*.env.*", effect: ask }
  - { action: edit, resource: ".github/workflows/*", effect: ask }
  # A planted .git file or directory would make the allowed git commands load
  # a config the agent wrote, and some config keys run commands.
  - { action: edit, resource: "*.git", effect: ask }
  - { action: edit, resource: "*.git/*", effect: ask }
  # No builds, tests, package managers, commits, or pushes: running any of
  # them would execute code the agent wrote, next to the job's credentials.
  - { action: shell, resource: "git log*", effect: allow }
  - { action: shell, resource: "git show*", effect: allow }
  - { action: shell, resource: "git blame*", effect: allow }
  - { action: shell, resource: "git status*", effect: allow }
  - { action: shell, resource: "git ls-files*", effect: allow }
  - { action: shell, resource: "git ls-tree*", effect: allow }
  - { action: shell, resource: "git rev-parse*", effect: allow }
  - { action: shell, resource: "git merge-base*", effect: allow }
  # Given two paths, git diff reads files outside the repository, so it is
  # only allowed against a pull request ref or for uncommitted edits. The
  # path rules below refuse the outside paths that could still switch it to
  # comparing files.
  - { action: shell, resource: "git diff", effect: allow }
  - { action: shell, resource: "git diff --stat", effect: allow }
  - { action: shell, resource: "git diff -- *", effect: allow }
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
