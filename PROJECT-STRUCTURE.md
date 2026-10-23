# Project structure

The root [package.json](package.json) defines the npm workspaces in `packages/*`. Each package's
manifest and export map define its supported entry points. Use [architecture and source ownership](docs/development/architecture.md)
for dependency boundaries, authored types and application composition; this page locates the source.

## Packages

| Work area                                                                        | Source                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Graph authoring, validation, execution and projections                           | [workflow-engine](packages/workflow-engine/)                                             |
| Foundation primitives, application services, SQL repositories and authentication | [shared](packages/shared/)                                                               |
| MCP transport, tools and portable help                                           | [mcp-server](packages/mcp-server/)                                                       |
| HTTP routes and admission                                                        | [web-backend](packages/web-backend/)                                                     |
| React editor, run views and browser state                                        | [web-frontend](packages/web-frontend/)                                                   |
| Workflow definition CLI                                                          | [workflow-cli](packages/workflow-cli/)                                                   |
| Astro/Starlight website and localized presentation                               | [docs](packages/docs/)                                                                   |
| Paired host controller and VM lifecycle                                          | [local](packages/local/)                                                                 |
| Common guest command, file, session and result owner                             | [workspace-service](packages/workspace-service/)                                         |
| Extension contracts and isolated execution                                       | [extension-sdk](packages/extension-sdk/), [extension-runner](packages/extension-runner/) |

## Other owners

- [tests/](tests/): maintained root suites and fixtures. [TESTING-GUIDE.md](tests/TESTING-GUIDE.md)
  owns commands; [COVERAGE-MAP.md](tests/COVERAGE-MAP.md) locates behavior coverage.
- [workflows/production/](workflows/production/): bundled workflow and playbook catalogs. Use
  [catalog reconciliation](docs/reference/bundled-catalog.md) and the [workflow CLI](docs/reference/workflow-cli.md).
- [config/](config/): image build, ingress/service configuration and canonical prompt assets.
  [scripts/](scripts/) owns build, startup, migration and maintenance entrypoints; supported commands
  come from the root manifest and [contributor setup](docs/development/getting-started.md).
- [docs/](docs/README.md): contributor, reference and operator documentation. User topics live in
  [portable help](packages/mcp-server/src/help/content/), composed into the EN/RU website by the docs
  package. [Documentation ownership](docs/development/documentation.md) explains the shared sources.
- [examples/extensions/](examples/extensions/) and [extensions/](extensions/): extension examples
  and the optional installation mount; see [extension authoring](packages/mcp-server/src/help/content/guides/writing-extensions.md).
- [.github/](.github/): CI, release and contribution-policy automation. [CONTRIBUTING.md](CONTRIBUTING.md)
  owns the contributor process.

The self-host Compose installation keeps application state in `./data`; workspace bytes and original
operations belong to their separate owners. The contributor container is disposable. Follow
[configuration](docs/operator/configuration.md) and [workspace custody](docs/reference/workspaces.md)
rather than treating generated directories or source checkouts as durable production storage.
