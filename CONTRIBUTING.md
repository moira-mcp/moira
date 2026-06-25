# Contributing to MCP Moira

Thanks for your interest in contributing! This document explains how to set up
the project, propose changes, and get them merged.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

### Prerequisites

- Node.js 20+
- Docker (for running the full stack and integration/e2e tests)

### Setup

```bash
# Install dependencies (npm workspaces — installs all packages)
npm install

# Copy the example env and adjust if needed
cp .env.example .env

# Build and run the full stack locally
docker compose up -d --build
```

The app is then served at the host configured by `MOIRA_HOST` in your `.env`
(default `localhost:8080`).

### Running tests

```bash
npm test                 # full suite
npm run test:unit        # unit tests (no Docker needed)
```

See `tests/TESTING-GUIDE.md` for details on the test categories.

## Making changes

1. Fork the repository and create a feature branch from `master`.
2. Make your changes, keeping them focused and well-scoped.
3. Add or update tests for any behavior change.
4. Run the test suite and make sure it passes.
5. Update documentation if you changed user-facing behavior.
6. Open a pull request against `master` describing what and why.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
Every commit must be signed off, certifying that you wrote the change or have the
right to contribute it under the project's license. Sign off with:

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` line to the commit message.

## Releases & versioning

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/)
driven by [Conventional Commits](https://www.conventionalcommits.org/). Write your
commit subjects accordingly:

| Commit type                                        | Effect                  |
| -------------------------------------------------- | ----------------------- |
| `fix: …`                                           | patch release (`0.0.X`) |
| `feat: …`                                          | minor release (`0.X.0`) |
| `feat!: …` or a `BREAKING CHANGE:` footer          | major release (`X.0.0`) |
| `docs:` / `chore:` / `refactor:` / `test:` / `ci:` | no release on their own |

**How a release happens.** `master` is protected — there are no direct pushes, and
only the maintainer merges PRs. Each merge to `master` runs the **Release** workflow:
semantic-release analyzes the commits since the last tag and, on a releasable change,
creates a git tag `v<version>` and a **GitHub Release** with generated notes (this is
the changelog). The release then publishes a versioned multi-arch image to
`ghcr.io/moira-mcp/moira` — `:<version>`, `:<major>.<minor>`, and `:latest`. No
secrets or manual steps are involved (the release uses only the built-in
`GITHUB_TOKEN`; it creates tags/releases, never pushing to `master`).

Self-host users upgrade simply by pulling the new image — see
[Updating / Upgrading](README.md#updating--upgrading) in the README.

**CI on pull requests** runs Lint, Unit, Integration, and a Docker build + API/MCP
tests. The Playwright **E2E** suite is flaky on shared runners, so it runs nightly
(and on demand) via `.github/workflows/e2e.yml` rather than gating PRs.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), the same license as the project.

## Documentation changes

When modifying the public documentation under
`packages/docs/src/content/docs/`:

- [ ] Page exists in **both** languages: `docs/` (English) and `ru/docs/` (Russian)
- [ ] Page is added to the sidebar configuration
- [ ] Internal links use the correct locale prefix (`/docs/` for EN, `/ru/docs/` for RU)
