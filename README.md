# repo-kit

Repository setup, release automation and AI agent configuration for GitHub
repositories, shared as one npm package and a set of reusable workflows.

- **CLI** (`@craftsamo/repo-kit`): commands a maintainer runs in a repository,
  such as configuring its GitHub settings or drafting a release.
- **Reusable workflows** (`craftsamo/repo-kit/.github/workflows/*.yml`): jobs a
  repository calls from its own workflows, pinned to a release tag.

Neither needs a configuration file in the repository that uses them. Values
that differ between repositories are passed as command-line options or
workflow inputs, and default to what most repositories use.

## Install

```sh
npm install --save-dev @craftsamo/repo-kit
npx repo-kit --help
```

Node.js 24 or later is required.

## Commands

Run `repo-kit --help` for the list. Every command works on the repository it
runs in: the top of the git worktree holding the current directory, or the
directory named by `REPOSITORY_ROOT`. Commands that reach GitHub use the
[GitHub CLI](https://cli.github.com/), authenticated as you.

## License

[MIT](LICENSE)
