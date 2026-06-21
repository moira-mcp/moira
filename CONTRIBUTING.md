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

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), the same license as the project.

## Documentation changes

When modifying the public documentation under
`packages/landing-page/src/content/docs/`:

- [ ] Page exists in **both** languages: `docs/` (English) and `ru/docs/` (Russian)
- [ ] Page is added to the sidebar configuration
- [ ] Internal links use the correct locale prefix (`/docs/` for EN, `/ru/docs/` for RU)
