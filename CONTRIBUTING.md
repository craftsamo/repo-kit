# Contributing to repo-kit

Thank you for helping. This guide covers how to propose a change, set up the
repository, and get a pull request merged. The rules the code itself follows
are in [AGENTS.md](AGENTS.md), which AI coding agents read too.

## Before you start

- Search the [issues](https://github.com/craftsamo/repo-kit/issues) and
  [pull requests](https://github.com/craftsamo/repo-kit/pulls?q=is%3Apr)
  first, closed ones included.
- Open an issue before adding a command, an option or a workflow input.
  Everything repo-kit adds becomes something every repository that uses it
  can pass, and repo-kit keeps that surface small: a value goes in only when
  repositories really differ on it, and it gets a default most of them can
  keep.
- A fix for a bug or a documentation error can go straight to a pull request.
- Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes,
  not in an issue or a pull request.

## Setup

You need Node.js 24 or later, and the [GitHub CLI](https://cli.github.com/)
to try commands against a repository.

```sh
git clone https://github.com/craftsamo/repo-kit.git
cd repo-kit
corepack enable
pnpm install
```

Run the CLI from the sources, against the repository you are in:

```sh
node src/cli.mts --help
```

Try commands that change a repository on one of your own, with `--dry-run`
first where the command has it.

## Checks

CI runs these on every pull request; run them before you push:

```sh
pnpm run format:check   # pnpm run format fixes it
pnpm run typecheck
pnpm test               # one suite: node --test test/<name>.test.mjs
pnpm run build
```

A change to a workflow should also pass
[actionlint](https://github.com/rhysd/actionlint), which CI runs as well.

## Making a change

- Follow the rules in [AGENTS.md](AGENTS.md). The ones that shape most
  changes: no runtime dependencies, no configuration file in the repositories
  that use repo-kit, and `git` and `gh` run only through the helpers in
  `src/github/gh.mts`.
- Add or update tests in `test/` for what you change.
- Update [README.md](README.md) when what a user runs, passes or sees
  changes.
- For a reusable workflow, also update the caller example in the header of
  the file and the permissions table in the README, and keep to GitHub-owned
  actions; `test/workflows.test.mjs` checks the rest.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): subject`, in the imperative.

| Type       | For                                         |
| ---------- | ------------------------------------------- |
| `feat`     | A new command, option, workflow or input    |
| `fix`      | Something that did not work as documented   |
| `docs`     | Documentation only                          |
| `ci`       | This repository's own CI and release jobs   |
| `refactor` | Restructuring without a change in behavior  |
| `test`     | Tests only                                  |
| `chore`    | Anything else, such as tooling or a version |

The scope names the area, such as `setup`, `release`, `agents`, `labels` or
`ci`. Keep each commit to one change that passes the checks on its own; the
body says why, when the subject cannot.

## Pull requests

- Branch from `main` and name the branch after the change, such as
  `fix/label-rename` or `docs/security-policy`.
- Keep a pull request to one change. Describe what it changes and why, how
  you checked it, and the issue it closes.
- A maintainer labels the pull request. The label decides its section in the
  release notes and how far the next version moves:

  | Label            | Version                       |
  | ---------------- | ----------------------------- |
  | `breaking`       | major                         |
  | `feature`        | minor                         |
  | any other        | patch                         |
  | `skip-changelog` | left out of the release notes |

  [RELEASING.md](RELEASING.md) describes the rest of a release.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
