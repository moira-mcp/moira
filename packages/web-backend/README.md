# @mcp-moira/web-backend

Express HTTP backend for workflow authoring, execution views, account/settings administration and
authenticated workspace/controller transport. It composes the shared application services and the
workflow engine; persisted workflow and execution state belongs to SQLite.

## Develop and verify

Use the root workspace and [contributor setup](../../docs/development/getting-started.md).
The existing contributor container helper builds and runs the application:

```bash
npm run docker:restart
npm run docker:stop
```

Select the target environment and unused public port before starting it. The
[testing guide](../../tests/TESTING-GUIDE.md) owns focused API/integration commands and fixture
boundaries; [configuration](../../docs/operator/configuration.md) owns origins and environment settings.

## HTTP and domain boundaries

Routes are mounted in [`src/server.ts`](src/server.ts). `/api` provides discovery; the
[HTTP reference](../../docs/reference/http-api.md) owns current paths, request fields, admission,
pagination and response exceptions. Public health is `/api/health`, with configuration and detailed
status at `/api/health/config` and `/api/health/status`. Definitions are identified by server ID or
authorized slug/reference, not filesystem folder routes.

Apply authorization at the owning route/domain boundary. Public health/discovery, browser sessions,
one-purpose download grants and private controller credentials have different admission contracts;
do not wrap them in a blanket session requirement. Private binary transport authenticates before
reading its body and bypasses ordinary JSON logging.

Use the single owners for [architecture](../../docs/development/architecture.md),
[execution and replay](../../docs/reference/execution.md),
[authentication](../../docs/reference/authentication.md),
[workspaces](../../docs/reference/workspaces.md) and
[observability](../../docs/development/observability.md). A route status alone does not prove that
no state or external effect was committed.
