# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the details of the issue.

If you are unable to use Private Vulnerability Reporting, you may also email the
maintainers (see the repository's profile for the current security contact).

Please include as much of the following as you can:

- The type of issue (e.g. authentication bypass, injection, SSRF, etc.).
- The affected component (package, file, endpoint).
- Step-by-step instructions to reproduce.
- Proof-of-concept or exploit code, if available.
- The impact of the issue, including how an attacker might exploit it.

## Response

Reports are handled privately. Response and remediation timing depends on the
issue's impact, reproducibility, and fix readiness; no fixed service timeline is
guaranteed. Maintainers may request additional information and coordinate
disclosure when a fix is ready.

## Supported Versions

Moira is pre-1.0. Security fixes are applied to the latest released version.
Until a stable release line is established, only the most recent version
receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Scope

This policy covers the Moira application code in this repository. The public
self-host deployment model (Docker image, `docker-compose.yml`) is in scope.
Issues in third-party dependencies should generally be reported upstream, but
let us know if a dependency issue affects Moira so we can update or mitigate.

## Automated Controls

Dependabot schedules grouped root npm and GitHub Actions version updates weekly.
Once security updates are enabled, npm security fixes are processed from security
advisories and grouped separately by production or development dependency type;
they do not wait for the weekly version-update schedule. Automated update PRs use
the existing `type:chore` and `component:infrastructure` labels.

The **Security Checks** pull-request gate checks newly introduced moderate-or-higher vulnerable
dependencies across runtime, development, and unknown scopes. License policy is
not part of this gate. GitHub Actions workflows are checked with actionlint, and
every external Action must use an immutable commit SHA or image digest.

These controls reduce new supply-chain risk; they do not mean that all existing
dependency or code alerts are resolved. Current alerts are tracked and remediated
through reviewed dependency or code changes. Continue to report suspected
vulnerabilities privately through the process above.
