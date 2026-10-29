# AGENTS

repo-kit is an npm package (`@craftsamo/repo-kit`) with a CLI, and a set of
reusable GitHub Actions workflows that other repositories call. Both are
released together from this repository.

## Layout

- `src/` — TypeScript sources (`.mts`), built to `dist/*.mjs`. `src/cli.mts`
  is the only entry point; `src/main.mts` holds the command table.
- `assets/` — files the commands and workflows read at run time, shipped in
  the package as they are.
- `test/` — `node --test` suites (`.test.mjs`) that import `src/` directly.
- `.github/workflows/` — this repository's CI, and the reusable workflows.

## Rules

- **Two roots, never mixed.** The repository a command works on comes from
  `repositoryRoot()` (where the command runs, or `REPOSITORY_ROOT`). Files of
  repo-kit itself come from `assetPath()` / `packageRoot`, which work from both
  `src/` and `dist/`. Never derive one from the other.
- Run `git` and `gh` through `runCommand()` / `api()` in `src/github/gh.mts`,
  which run them in the repository root and report failures as
  `CommandError`.
- **No configuration file in consumer repositories.** A value that differs
  between repositories is a command-line option or a workflow input with a
  default.
- **No runtime dependencies.** Commands use Node.js and the `gh` and `git`
  executables only.
- A command module exports `run(argv)` and does nothing when imported; it is
  registered in `src/main.mts`.
- Sources use only erasable TypeScript syntax and import siblings with their
  `.mts` extension; the build rewrites them to `.mjs`.
- Reusable workflows check out repo-kit with `job.workflow_repository` and
  `job.workflow_sha` and run `src/cli.mts` from it, use GitHub-owned actions
  only, and never call another workflow with `./`, which resolves to the
  caller's repository. `test/workflows.test.mjs` checks this.

## Commands

- `pnpm run typecheck`, `pnpm test`, `pnpm run build`
- `pnpm run format` / `pnpm run format:check`
- Single test: `node --test test/<name>.test.mjs`
