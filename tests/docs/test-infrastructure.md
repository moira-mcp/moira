# Test infrastructure

Start with the [testing guide](../TESTING-GUIDE.md) to choose a suite. Root npm scripts use
[Testfold configuration](../../test-runner.config.mjs); package directories do not provide separate
test runners.

## How it works

Testfold selects the environment, invokes the configured Jest or Playwright command, captures its
output and reports the outcome. Use `--file` after npm's argument separator for a focused run:

```bash
npm run test:unit -- --file tests/unit/web-frontend/mcp-prompts-editor.test.tsx
npm run test:workflow -- --file tests/workflow/scenarios/coverage.test.ts
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts
```

The [result guard](../../scripts/test-runner-result-guard.mjs) rejects apparent success without a
valid executor-owned zero exit code and an executed passing test. Playwright additionally needs a
valid report with no global errors. Empty or skipped-only reports and setup/teardown failures do
not establish a pass. Existing test failures retain their original diagnostics.

## Discovery and preparation

| Suite       | Discovery owner                                                                                             | Preparation and isolation                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | [Jest unit config](../config/jest.unit.config.js): `tests/unit/**/*.test.ts`, `.tsx`, `.cjs`                | Testfold builds common workspace programs; global setup builds native process helpers. Tests own temporary files, subprocesses and sockets. JSX tests opt into jsdom. |
| Workflow    | [Jest workflow config](../config/jest.workflow.config.js): `tests/workflow/**/*.test.ts`                    | Graph-engine contract tests and authored-flow scenarios; no deployed server required.                                                                                 |
| Integration | [Jest integration config](../config/jest.integration.config.js): `tests/integration` and `tests/functional` | Global setup builds Local/native/owner programs and prepares `data/test-integration.db`. Files share that migrated database and run in one worker.                    |
| API         | [Jest API config](../config/jest.api.config.js): `tests/api/**/*.test.ts`                                   | Real target HTTP/authentication; deployment-specific exclusions depend on `API_TEST_TARGET`.                                                                          |
| MCP         | [Jest MCP config](../config/jest.mcp-tools.config.js): `tests/mcp-tools/**/*.test.ts`                       | Authenticated SDK transport to the target server.                                                                                                                     |
| E2E         | [Playwright config](../config/playwright.config.ts): `tests/e2e/**/*.spec.ts`                               | Browser fixtures, global setup and ordered project dependencies.                                                                                                      |

Jest uses SWC to transform TypeScript. The root [base config](../config/jest.base.config.js),
[setup](../setup.ts), [jsdom polyfills](../setup-jsdom.ts) and SQLite error-realm setup have distinct
consumers; keep them when changing a suite. Test types are checked by `npm run typecheck:tests`,
including a separate frontend configuration with bundler resolution and the frontend alias.
Worker limits and timeouts belong to the linked configs.

Common workspace asset publication compiles each program before writing, syncing and renaming an
exclusive sibling temporary file. Held readers retain the complete original program. This is
per-file publication, not a transaction over the whole payload. Test preparation does not package
guest archives, provider toolchains, fonts or a complete guest release.

## Target selection

```bash
npm run test:api                 # local target
npm run test:mcp-tools:remote    # configured remote target
npm run test:e2e:remote
```

The environment definitions in `test-runner.config.mjs` own local, remote and CI routing. Local
server suites use `.env.local`; remote routing also uses `.env.remote`. CI SaaS and self-host runs
use separate deployment contexts. `npm run verify:docker` owns the paired container checks; its
`MOIRA_VERIFY_ENV_FILE` and `MOIRA_TEST_SELF_HOST_PORT` overrides support isolated worktrees.
Keep local environment files untracked and consult the local port inventory before assigning ports.

Deployed-server requests use [test-config](../utils/test-config.ts).
`getTestBaseUrl()` honors `TEST_BASE_URL`; otherwise it requires `DOCKER_PORT` and delegates to the
[resolver](../utils/remote-url-resolver.ts). Browser navigation and direct Node HTTP may need
different hosts: `getTestFetchUrl()` deliberately resolves separately. Setting `TEST_BASE_URL`
alone does not redirect every transport. Component fixtures own their private listener or socket
instead of borrowing a deployed target's URL.

## E2E projects

Playwright runs installation-wide settings writers in `global-settings` before the parallel
`chromium` readers. Selecting a Chromium file also runs the complete dependency project; selecting
a settings-writer file runs its matching cases. Failure of the dependency prevents Chromium from
running and leaves the invocation failed. It does not make later settings cases a serial test group.

Inspector, self-host account-approval and platform snapshot specs require additional preparation.
The config excludes its external-service set in CI and unless `PLAYWRIGHT_INCLUDE_EXTERNAL=true`.
That flag enables discovery; it does not start those dependencies or authorize external effects.
See [browser testing](e2e-testing.md).

## Artifacts and concurrent runs

Testfold writes per-suite JSON, executor logs, timing and Markdown failure reports under
`test-results/artifacts/`. Inspect failure reports first and the executor log for crashes or
preparation failures. Raw framework JSON is evidence for assertions, not a replacement for the
aggregated runner outcome.

A whole-run lock serializes runner processes sharing the artifact directory. A focused run cleans
its own suite's artifacts, so preserve evidence needed for diagnosis before another invocation of
that suite. Summaries and timing describe the latest invocation.

The hosted integration job uses a byte-verified private Node executable to satisfy process-custody
ownership checks without changing shared toolcache permissions. Native fixtures and the
[packaged/native acceptance](../TESTING-GUIDE.md#native-and-provider-acceptance) have separate
evidence boundaries.
