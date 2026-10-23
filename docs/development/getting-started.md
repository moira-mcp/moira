# Contributor setup

Read [CONTRIBUTING](../../CONTRIBUTING.md) before implementation. It owns issue coordination,
claims, pull requests and DCO sign-off. Use the [architecture guide](architecture.md) to locate the
component that owns a change; [testing](../../tests/TESTING-GUIDE.md) is the single test entry.

## Select a development environment

Use Node.js 24 and the root npm workspace. The repository's `.nvmrc` selects its contributor
runtime; installed companion and guest releases carry their own runtime.

```bash
nvm use
npm ci
cp .env.local.example .env.local
```

Set the required authentication secret and choose an unused loopback port in `.env.local`.
Consult any machine-local port inventory before starting a listener. Keep environment files and
credentials outside Git. The [operator configuration guide](../operator/configuration.md) owns
deployment settings and public origins.

The contributor helper builds a baked image, creates its development container and waits for
readiness:

```bash
npm run docker:restart
npm run docker:stop
```

It reads `.env.local`, uses `DOCKER_CONTAINER_NAME`, `DOCKER_IMAGE_NAME` and `DOCKER_PORT`, and binds
to loopback unless `DOCKER_BIND_ADDRESS` explicitly changes that. It bind-mounts `workflows/` for
catalog work. Its application database is container-local and is discarded when the container is
recreated; do not use it for user data. Public `docker-compose.yml` is a different, persistent
self-host installation with `./data`. Restarting either container retains its existing image;
rebuild and recreate to run changed application, frontend, prompt or documentation bytes.

Use the selected public port for browser and ordinary API/MCP traffic. Public Compose additionally
routes workspace upgrades directly through its ingress; do not replace that route with an
ordinary HTTP buffering proxy. The [workspace reference](../reference/workspaces.md) owns that
transport and the separate host companion.

## Make and verify a change

Choose an existing test that observes the affected behavior and run it through the root scripts:

```bash
npm run test:integration -- --file tests/integration/server-workflow-admission.test.ts
npm run typecheck:tests
```

Use the [coverage map](../../tests/COVERAGE-MAP.md) to find the right owner. Run browser/API/MCP
suites only against an intentionally selected test installation with owned fixtures. A mocked
provider, intercepted browser response or compiled guest is not real provider acceptance.

Keep an executable change with its real consumers: schema/type exports, handler bindings,
serialization, persisted state, generated assets and both language views where applicable.
Workflow authoring uses the maintained [CLI](../reference/workflow-cli.md) and the current Workflow
Management Flow; [bundled catalog](../reference/bundled-catalog.md) explains installation and
reconciliation. Do not simulate successful workflow steps to validate a definition.

Run the native contribution gates before push as required by the project:

```bash
npm run verify
npm run verify:docker
```

`verify` covers host lint, formatting, type checks and the supported non-server suites.
`verify:docker` builds and exercises the container-backed SaaS/self-host boundaries. Use it for
changes to a published tool contract or container-served behavior. The test guide explains target
selection, artifact collection and scope. Diagnose a failing check instead of changing a timeout,
skipping an assertion or repeatedly rerunning it.

## Build the companion and guest

These are separate programs from the web container:

```bash
npm run local:build
npm run local -- --help
npm run typecheck:local
npm run workspace:build
npm run workspace:package -- --arch x64
npm run workspace:package -- --arch arm64
```

Keep complete packaged releases, including native helpers, renderer assets and copied runtime.
Building or staging an update does not replace an active physical owner. Installation,
maintenance, original-outcome collection and protected state are described in
[workspaces](../reference/workspaces.md). An ordinary test fixture does not authorize SDK login,
owner interruption or live VM changes.

`npm run workspace:verify:guest` packages and runs the common Linux service in an offline container
using its installed assets. Its pinned image must already be available. It does not prove native
microVM isolation or live GitHub/vendor behavior; the [testing guide](../../tests/TESTING-GUIDE.md#native-and-provider-acceptance)
defines those distinct boundaries.

## Debug the selected target

Read the target's `/app/BUILD_INFO` to establish which source it actually runs. Dirty builds use a
content identity rather than claiming an unchanged clean commit. A passing host test is not proof
that the running image contains the change.

Use [observability](observability.md) for logs, traces and execution inspection. Persisted workflow
state belongs to SQLite and the execution repositories; do not diagnose current runs by inventing
`.graph-storage` JSON files. Retain original operation references after lost replies and inspect
them before another mutation.

The optional `docker-compose.inspector.yml` defines a separate MCP Inspector fixture. Its checked-in
configuration publishes its UI/proxy ports and disables Inspector authentication. It is not a
default Moira runtime or an authorization bypass; use an explicitly isolated, selected test fixture
and the same current MCP authentication/catalog-initialization contract as a real client.

## Maintain tooling and dependencies

Use the shared configuration getters rather than direct environment reads in production code, the
project logger rather than console output, and canonical domain types rather than copied models.
Handle errors at the owning boundary without swallowing failures. Narrow discriminated variants
before accessing their fields; keep browser imports type-only where required by architecture.

The root manifest, lockfile, overrides and Dependabot configuration own the selected dependency
ranges and exceptions. Review peer/runtime compatibility before changing a pin. Update exact
`allowScripts` entries only after reviewing the corresponding package installation script; remove
unused entries in the same change. Verify the affected runtime/build boundary with a clean peer
graph instead of installing with compatibility flags. Do not infer current compatibility from an
old major-version migration proposal.
