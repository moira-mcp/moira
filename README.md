# MCP Moira

Moira is a workflow engine for AI agents. An agent connects through the Model Context Protocol
(MCP), receives the current instruction and completion criteria, performs the work, and submits a
schema-checked response. Moira persists execution state so another agent session can continue the
same run. The Web UI provides workflow editing, run inspection and account administration.
Schema validation checks a response's structure; it does not prove that the work happened.

Run the open-source application on your own infrastructure, or use the managed service at
[moira-mcp.com](https://moira-mcp.com). This repository contains the engine, MCP server, Web API/UI,
documentation and self-host deployment. See [the documentation index](docs/README.md) and
[project structure](PROJECT-STRUCTURE.md) for source ownership.

## Self-host

Install Docker with the Compose plugin. Use this checkout, or download the three deployment files
following the [Self-Hosting guide](packages/mcp-server/src/help/content/getting-started/self-hosting.md#quick-start):
`docker-compose.yml`, `.env.example` and `config/traefik-self-host.yml`. Keep the ingress configuration
beside the Compose file.

```bash
cp .env.example .env
docker compose up -d
```

The localhost defaults pull the public image without a source build. Open:

- Web UI: <http://localhost:8080>
- Documentation: <http://localhost:8080/docs/> (English) or <http://localhost:8080/ru/docs/> (Russian)
- MCP endpoint: <http://localhost:8080/mcp>

For another host, set `MOIRA_HOST`, `MOIRA_PORT` and `STATIC_ARTIFACTS_DOMAIN` together in `.env`.
Published HTML artifacts use individual subdomains of the artifact domain; public deployments need
the matching DNS and wildcard TLS. Preserve the supplied workspace Upgrade route through ingress;
an ordinary frontend-port mapping is not equivalent. Configure proxy trust for your actual topology.
See [deployment configuration](docs/operator/configuration.md) for origins, secrets, email and network admission.

Self-host registration requires administrator approval. On first start the image generates missing
secrets and prints the generated administrator password once; the default administrator email is
`admin@moira.local`. Preserve `data/.secrets.env` with the database. Sign in, then approve new
accounts through **Admin Panel → Users**. Self-host uses email/password; social login and broader
cross-user administration/analytics follow the separate SaaS policy. See
[account administration](docs/operator/accounts.md) for approval, blocking, password recovery and
administrator access recovery, including installations without real email delivery.

## Connect an agent and use workflows

Connect your MCP client to your instance's `/mcp` endpoint and complete its authenticated
authorization flow. Use the [MCP Clients guide](packages/docs/src/content/docs/docs/integration/mcp-clients.mdx)
for the configuration generated for each supported client. The connection name `moira-local` is a
client label, independent of the optional Local companion executable.

Ask the agent to discover available workflows and choose the current exact `owner/slug` for the
task. The [workflow catalog](packages/docs/src/content/docs/docs/reference/workflows/index.mdx)
explains the choices; the [Agent Guide](packages/mcp-server/src/help/content/integration/agent-guide.md)
owns prepare/execute, step attempts, continuation and guarded cancellation. Runtime `help` discovers
English topics; `help({ topic: "tools" })` renders the current typed tool catalog. The website also
provides Russian translations.

Use [workflow authoring](packages/mcp-server/src/help/content/guides/workflow-creation.md) and the
[workflow CLI](docs/reference/workflow-cli.md) to create or edit definitions. Node syntax, templates,
tool schemas and examples stay in their canonical references rather than a second README catalog.
For public HTML results, see [artifacts](packages/mcp-server/src/help/content/concepts/artifacts.md)
for upload, ownership, quotas, expiry and browser isolation.

## Update and recover

Use the image selection in your installation's `.env`, then:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Before startup migrations of an existing self-host database, the image verifies a coherent SQLite
snapshot and the prompt-manifest state. It retains rotating recovery states and an interruption
marker; failure attempts restoration and keeps services unavailable. A first start has a separate
cleanup path because no previous database exists. These safeguards do not replace operator backups.
If initialization fails, inspect `docker compose logs moira` and follow
[Updating and Recovery](packages/mcp-server/src/help/content/getting-started/self-hosting.md#updating-and-recovery);
do not bypass the guard or repeatedly restart an unchanged failure. A confirmed bundled-workflow
conflict uses the [catalog reconciliation procedure](docs/reference/bundled-catalog.md#self-host-conflict-recovery).

Application accounts, workflows and executions persist in `./data`. Workspace files, full command
output, operation receipts and immutable publications remain with their workspace service or paired
controller. Back up those private owner stores and disks separately; a database backup does not
contain their file bytes. Preserve encryption keys, and collect original operations after uncertain
outcomes before considering another mutation. See [workspace recovery](docs/reference/workspaces.md#recovery-and-collection)
and [GitHub Releases](https://github.com/moira-mcp/moira/releases).

## Optional workspace and extension support

The paired Local controller can provision the common workspace service in GitHub Codespaces and
run approved repositories in Local microVMs. Controller enrollment does not require initializing
a physical Local VM. Local VM execution requires the supported macOS Apple-silicon runtime and
explicit owner grants; repository Git authority is separate from social login. From the checkout:

```bash
npm ci
npm run local:build
npm run local -- --help
```

Follow [workspace setup and custody](docs/reference/workspaces.md) for pairing, physical capability,
permissions, installation and explicit maintenance. Staging a release does not replace the running
owner; client exit does not stop its VMs. The common `moira-workspace` guest CLI owns commands, files,
sessions and original results in both Local and GitHub guests. Lost replies require collecting the
original operation, not replaying the command or creating a replacement environment.

Extensions are disabled by default. The optional Compose profile builds a separate runner from this
checkout; binary channels execute beside their source owner. Follow
[Enable extensions](packages/mcp-server/src/help/content/getting-started/self-hosting.md#enable-extensions)
and [Writing an Extension](packages/mcp-server/src/help/content/guides/writing-extensions.md) for bundle
installation, permissions, user settings and failure boundaries.

## Contribute

Read [CONTRIBUTING](CONTRIBUTING.md) for issue coordination, pull requests, DCO and release policy.
Use Node.js 24 and the root npm workspace:

```bash
nvm use
npm ci
```

[Contributor setup](docs/development/getting-started.md) explains the isolated development container,
environment selection and native build commands. The [testing guide](tests/TESTING-GUIDE.md) owns
suite selection and root npm entrypoints; [the coverage map](tests/COVERAGE-MAP.md) locates maintained
fixtures. Do not use the disposable contributor container for persistent installation data.

Start at [docs/README.md](docs/README.md) for architecture, execution, HTTP/authentication,
workspaces, UI patterns, documentation ownership, observability and operator procedures. Custom
Claude Code commands are documented in [commands/README.md](commands/README.md). Current work is
tracked in [GitHub Issues](https://github.com/moira-mcp/moira/issues).

## License, security and branding

Source code is licensed under [Apache-2.0](LICENSE). See [third-party notices](THIRD_PARTY_LICENSES),
[the trademark policy](TRADEMARK.md) for name/logo use, [the code of conduct](CODE_OF_CONDUCT.md),
and [SECURITY.md](SECURITY.md) for vulnerability reporting. Private deployment branding, secrets and
operational material belong outside this public repository.
