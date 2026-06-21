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

- We aim to acknowledge a report within **5 business days**.
- We will keep you informed of the progress toward a fix and full announcement.
- We may ask for additional information or guidance.
- Once a fix is available, we will coordinate a disclosure timeline with you.

We ask that you give us a reasonable amount of time to address the issue before
any public disclosure.

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
