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

### `setup github`

Applies the repository's settings, after showing every change and asking to
confirm. You need administrator permission, and the repository needs a `main`
branch.

- Merge methods, features, and default commit titles and bodies
- GitHub Actions: GitHub-owned actions plus the third-party actions and
  reusable workflows the repository's workflows use, a read-only default
  token that may open pull requests, and artifact, log and cache retention
- Secret scanning with push protection, and Dependabot alerts; security
  updates only if you enable them
- Labels from `.github/labels.yml`, pruning undeclared ones; without the file,
  labels are left as they are
- A `Protect main` ruleset requiring pull requests and a passing required
  check, or classic branch protection where rulesets are unavailable
- When a workflow reads `secrets.RELEASE_DEPLOY_KEY`: a writable deploy key
  with that secret, which may bypass the ruleset to push the version bump
- Optionally: description, homepage, topics, and the `/oc` model variables

| Option                    | Default           |                                                          |
| ------------------------- | ----------------- | -------------------------------------------------------- |
| `--required-check <name>` | `Required checks` | The job every pull request into `main` must pass         |
| `--ci-workflow <file>`    | `tests.yml`       | The workflow that runs it; setup runs it once to find it |
| `--repo <owner/name>`     | the `gh` remote   | The repository to set up                                 |
| `--defaults`              |                   | Skip the optional questions                              |
| `--dry-run`               |                   | Show the changes without applying them                   |
| `--yes`                   |                   | Apply without asking                                     |

### `setup secrets`

Sets secrets through `gh secret set`, so their values never pass through
repo-kit. Without options it asks for the `/oc` provider keys
(`OPENCODE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`); set only the ones you use. For another secret:

```sh
repo-kit setup secrets --scope repository --name API_TOKEN
repo-kit setup secrets --environment production --name DATABASE_URL
```

A missing environment is created; an existing one keeps its protection rules.

## License

[MIT](LICENSE)
