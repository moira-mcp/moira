# Project documentation

Choose the guide for the work you are doing. [CONTRIBUTING](../CONTRIBUTING.md) owns issue claims,
pull requests and DCO. [AGENTS](../AGENTS.md) contains the agent working contract. User-facing
documentation is served at `/docs/` and `/ru/docs/` by the public documentation package.

## Change the project

| Task                                                       | Owner                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Prepare a checkout, run a development image, choose checks | [Contributor setup](development/getting-started.md)     |
| Locate domain, composition and package boundaries          | [Architecture](development/architecture.md)             |
| Change runtime help, translations or website content       | [Documentation ownership](development/documentation.md) |
| Work on routes, editor state, live views or guides         | [Web UI](development/web-ui.md)                         |
| Reuse visual, form and interaction components              | [UI patterns](development/ui-patterns.md)               |
| Diagnose logs, metrics and audit observations              | [Observability](development/observability.md)           |
| Understand security and trust boundaries                   | [Security](development/security.md)                     |
| Choose tests and maintained fixtures                       | [Testing](../tests/TESTING-GUIDE.md)                    |

## Look up a contract

| Subject                                                           | Owner                                            |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| Presentations, steps, recovery, progress and live execution reads | [Execution](reference/execution.md)              |
| HTTP admission, resource routes and responses                     | [HTTP API](reference/http-api.md)                |
| Accounts, sessions, OAuth and MCP initialization                  | [Authentication](reference/authentication.md)    |
| Local/GitHub owners, commands, files and custody                  | [Workspaces](reference/workspaces.md)            |
| Read, edit and validate a definition locally                      | [Workflow CLI](reference/workflow-cli.md)        |
| Install bundled workflows/playbooks and resolve conflicts         | [Bundled catalogs](reference/bundled-catalog.md) |

## Operate an installation

- [Configuration](operator/configuration.md): mode, environment, origins, storage and startup.
- [Accounts](operator/accounts.md): approval, recovery and administrator operations.

Private deployments keep their branding, secrets, runbooks and private workflows in their private
repository. Current public work belongs in [GitHub Issues](https://github.com/moira-mcp/moira/issues),
with private work in its private tracker; this tree does not contain a second plan or backlog.
