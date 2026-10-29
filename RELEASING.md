# Releasing repo-kit

repo-kit releases itself with its own commands and workflows.

1. Label each pull request: `feature` raises the minor version, `breaking` the
   major, and anything else the patch; `skip-changelog` leaves it out.
2. Once CI passes on `main`, the Release workflow redrafts the next release.
3. Run the Publish workflow from the Actions tab. It sets the version in
   `package.json` on `main`, publishes the draft on that commit, publishes the
   package to npm with a provenance statement, and moves the major tag, such
   as `v1`, which callers of the reusable workflows pin.

A release published on the Releases page instead stops before npm, because
its tag names a commit before the version bump; publish with the workflow.

Run Publish once at a time. GitHub keeps one waiting run per concurrency
group and drops an older waiting one, so a release whose npm job was dropped
is on GitHub but not on npm: re-run that job. A version older than npm's
`latest` is published under the `maintenance` tag and leaves the major tag
where it is.

## One-time setup

1. Run `repo-kit setup github` in this repository. Since `publish.yml` reads
   `RELEASE_DEPLOY_KEY`, it creates the deploy key that pushes the version
   bump to `main`.
2. Publish the first version by hand, since npm accepts a trusted publisher
   only for a package that exists:

   ```sh
   repo-kit release sync --version 1.0.0
   git pull
   npm publish
   gh release create v1.0.0 --target main --title v1.0.0 --generate-notes
   git fetch --tags && git tag v1 v1.0.0 && git push origin v1
   ```

3. On npmjs.com, under the package's settings, add a trusted publisher:
   GitHub Actions, repository `craftsamo/repo-kit`, workflow `publish.yml`.
   Later releases then need no npm token.
