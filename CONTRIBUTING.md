# Contributing to MCP Moira

Thanks for your interest in contributing! This document explains how to set up
the project, propose changes, and get them merged.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

### Prerequisites

- Node.js 24+
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

## Coordinate work through an issue

Before starting substantial implementation, find or open a GitHub issue and wait
until maintainers have made it claimable. An issue is claimable only when all of
these conditions are visible at the same time:

- it is open and is an issue, not a pull request;
- it has no assignee;
- it has exactly one status label, `status:ready`;
- it has exactly one implementation type: `type:bug`, `type:feature`,
  `type:chore`, or `type:docs`.

Epics, questions, and issues waiting for triage, investigation, design, author
input, a dependency, or current implementation are not claimable. Missing,
unknown, duplicate, or contradictory `status:*` or `type:*` labels require maintainer
recovery; do not guess which state was intended.

### Claim an issue

Add a comment containing exactly:

```text
/claim
```

The repository automation serializes changes for that issue and rechecks its
current state. A successful claim has both of these public signals:

- you are the issue's only assignee;
- its only status is `status:in-progress`.

The bot also publishes a confirmation naming you and the absolute activity
deadline. Do not treat the issue as yours unless that confirmation appears. A
rejection explains whether the issue is occupied, not ready, inconsistent, or
requires maintainer recovery. A failed partial transition is rolled back when it
is still safe; ambiguous external changes are preserved for a maintainer instead
of being overwritten.

### Keep the claim active

The activity deadline is seven days after the latest qualifying activity. Only
GitHub events attributable to the current assignee qualify:

- a comment on the claimed issue, except `/release`;
- opening a pull request in this repository that GitHub links to the issue through
  a closing keyword such as `Closes #123` or `Fixes #123`;
- a comment by the assignee on that closing-linked pull request.

General pull-request `updated_at` changes do not qualify. Commits/pushes,
synchronize or base-branch events, CI/check activity, reviews, reactions, labels,
assignments, bot activity, other people's comments, cross-repository pull
requests, and issue mentions without a closing reference do not renew a claim.
Post a concise progress comment when in doubt.

After seven inactive days, the next successful scheduled reconciliation posts one
reminder. The three-day grace period starts at the trusted GitHub timestamp of
that actual reminder, not at the original deadline. If no qualifying activity
appears, the first successful reconciliation after the grace period releases the
claim. GitHub Actions schedules can be delayed, so these are minimum intervals,
not an exact promised release time. Later qualifying activity clears the reminder
and starts a new seven-day activity period.

### Release an issue

If you stop working on a claimed issue, add a comment containing exactly:

```text
/release
```

Only the current sole assignee can release a managed claim. A successful release
removes the assignee and changes the sole status back to `status:ready`. If a
release cannot be completed safely, the bot either restores the active claim or
marks it for maintainer recovery; never assume that a failed command released it.

### Maintainer recovery and overrides

Maintainer changes are authoritative. The automation does not replace a newer
assignee or contradictory status merely to satisfy its previous lease record. An
in-progress issue without a trusted bot lease record is treated as manually
managed and is not expired automatically.

To recover a damaged or partially applied managed claim:

1. Coordinate with the visible assignee before changing ownership.
2. Leave exactly one appropriate `status:*` and at most one intended assignee.
3. Delete obsolete bot comments containing `moira-issue-claim-state:v1`,
   `moira-issue-claim-reminder:v1`, or `moira-issue-claim-recovery:v1` when their
   recorded owner no longer matches the intended state.
4. For an available issue, leave it unassigned with `status:ready`; the next
   contributor can run `/claim`. To preserve manual ownership, leave one assignee
   with `status:in-progress`; it will not receive automatic lease expiry without a
   managed state record.
5. Run the **Issue claims** workflow manually with the issue number to verify a
   repaired managed claim or inspect the failed workflow logs for the guarded API
   boundary.

Assignees are the ownership source of truth. `status:in-progress` communicates the
lifecycle state but must not be used by itself to reserve work.

## Making changes

1. Claim a ready issue and wait for the bot's successful confirmation.
2. Fork the repository and create a feature branch from `master`.
3. Make your changes, keeping them focused and well-scoped.
4. Add or update tests for any behavior change.
5. Run the test suite and make sure it passes.
6. Update documentation if you changed user-facing behavior.
7. Open a pull request against `master`, follow the policy below, use a closing
   reference to the claimed issue, and describe what and why.

## Pull-request policy

Every pull request to `master` is checked by **PR Policy**. The check reports all
current findings together and runs again when the pull request is opened, edited,
reopened, or receives new commits.

Use this title form:

```text
type(scope)[!]: subject
```

Allowed types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, and `test`. The scope is required, lowercase, and
uses letters, digits, and internal hyphens. Replace `scope` and `subject` with
specific values. The optional `!` marks a breaking product change. Keep the title
within 160 characters. This form also keeps the title valid when it is used as a
squash commit subject.

### Link the work to an issue

Outside contributors must make GitHub recognize a closing reference to an issue in
this repository. Put a closing keyword in the pull-request body, for example:

```text
Closes #123
```

A plain issue mention does not count. Maintainers with effective `write`,
`maintain`, or `admin` permission may omit an issue only for repository
housekeeping whose title scope is `github`, `repo`, or `contributing`. Replace the
closing line with one concrete reason:

```text
No issue: refresh repository policy metadata
```

Author association labels such as MEMBER or COLLABORATOR do not grant this
exception, and product scopes cannot use it.

### Record testing evidence

Keep the `## Testing` section and record at least one concrete command or named
manual observation plus its observed outcome:

```markdown
## Testing

- Command: `npm run test:unit -- --file tests/unit/example.test.ts`
- Outcome: tests passed
```

For a manual check, use `- Manual: <observation>` instead of `- Command:`. The
policy verifies that both the verification and outcome are present; reviewers
still judge whether the evidence is adequate for the change.

### Automated dependency pull requests

Dependabot may omit the human issue, Testing, and DCO fields only when GitHub
identifies the pull request and every verified commit as the official
`dependabot[bot]` account and the title uses `build(deps): …` or
`build(deps-dev): …`. Other bots and partial identity matches follow the human
requirements. Dependabot schedules grouped root npm and GitHub Actions version
updates weekly. Npm security fixes from advisories use separate production and
development groups. They do not wait for the weekly version-update schedule.
Automated update PRs use the existing `type:chore` and
`component:infrastructure` labels.

### Automated security checks

**Security Checks** reviews newly changed dependencies for
moderate-or-higher vulnerabilities in runtime, development, and unknown scopes.
It also validates every GitHub Actions workflow with actionlint and rejects any
external Action that is not pinned to an immutable commit SHA or image digest.

The workflow treats pull-request files as untrusted static input and never runs
project scripts or dependencies. Fix a failure by updating the dependency or
workflow itself; do not add an allowlist, warning-only mode, floating tag, or
suppression file to bypass the check. Existing dependency alerts are remediated
separately and are not evidence that a dependency-neutral pull request failed.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
Every commit must be signed off, certifying that you wrote the change or have the
right to contribute it under the project's license. Sign off with:

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` line to the commit message.
**PR Policy** requires at least one such trailer whose name exactly matches that
commit's Git author name and whose email matches the Git author email
case-insensitively. `git commit -s` is the ordinary path when your configured Git
identity is also the commit author. For an amended, rewritten, or cherry-picked
commit, inspect its Git author and ensure the matching author trailer is already
present. Change the author only when that authorship remains accurate; otherwise
obtain the author's sign-off or omit the commit.

## Releases & versioning

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/)
driven by [Conventional Commits](https://www.conventionalcommits.org/). Write your
commit subjects accordingly:

| Commit type                                        | Effect                  |
| -------------------------------------------------- | ----------------------- |
| `fix: …`                                           | patch release (`0.0.X`) |
| `feat: …`                                          | minor release (`0.X.0`) |
| `feat(scope)!: …` or a `BREAKING CHANGE:` footer   | major release (`X.0.0`) |
| `docs:` / `chore:` / `refactor:` / `test:` / `ci:` | no release on their own |

Scopes `github`, `repo`, and `contributing` are always release-neutral, including
with `feat`, `fix`, `perf`, `!`, or a breaking-change footer. Use these scopes only
for repository automation, repository maintenance, and contribution-process work.
Product scopes such as `auth`, `workflow-engine`, `cli`, or `docs-site` keep the
normal release behavior shown above.

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

**CI on pull requests** runs PR Policy, Security Checks, Lint, Unit, Integration,
and a Docker build + API/MCP tests. The Playwright **E2E** suite is flaky on shared
runners, so it runs nightly (and on demand) via `.github/workflows/e2e.yml` rather
than gating PRs.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), the same license as the project.

## Documentation changes

When modifying the public documentation under
`packages/docs/src/content/docs/`:

- [ ] Page exists in **both** languages: `docs/` (English) and `ru/docs/` (Russian)
- [ ] Page is added to the sidebar configuration
- [ ] Internal links use the correct locale prefix (`/docs/` for EN, `/ru/docs/` for RU)
