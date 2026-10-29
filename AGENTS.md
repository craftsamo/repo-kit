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

- Files of repo-kit itself come from `assetPath()` / `packageRoot`, which work
  from both `src/` and `dist/`.
- **No configuration file in consumer repositories.** A value that differs
  between repositories is a command-line option or a workflow input with a
  default.
- **No runtime dependencies.** Commands use Node.js and the `gh` and `git`
  executables only.
- A command module exports `run(argv)` and does nothing when imported; it is
  registered in `src/main.mts`.
- Sources use only erasable TypeScript syntax and import siblings with their
  `.mts` extension; the build rewrites them to `.mjs`.

## Commands

- `pnpm run typecheck`, `pnpm test`, `pnpm run build`
- `pnpm run format` / `pnpm run format:check`
- Single test: `node --test test/<name>.test.mjs`
