# Testing guide

Use this entry to choose and run an existing suite. The [coverage map](COVERAGE-MAP.md) locates
responsibilities; the test source owns its exact assertions.

## Quick start

Use the repository's Node 24 runtime and root npm scripts:

```bash
npm run test:unit -- --file tests/unit/web-frontend/mcp-prompts-editor.test.tsx
npm run test:workflow -- --file tests/workflow/scenarios/quick-task.test.ts
npm run test:integration -- --file tests/integration/execution-stop.test.ts
npm run typecheck:tests
```

These suites do not require a deployed Moira server. Some fixtures compile native helpers or run
real processes, sockets and temporary databases; use the platform and dependency requirements of
the selected suite. Unit fixtures are not restricted to pure functions.

Server-facing suites need an intentionally selected test installation:

```bash
npm run test:api
npm run test:mcp-tools
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts
```

`npm test` selects all suites. `npm run verify` runs the local checks that do not require a server;
`npm run verify:docker` builds and checks the paired SaaS/self-host container contexts. Start the
ordinary development container with `npm run docker:restart` when appropriate. Before creating a
listener or assigning a worktree port, consult the local port inventory and keep environment files
out of Git. See [target selection and preparation](docs/test-infrastructure.md#target-selection).
Remote tests mutate their selected installation; use an authorized test target and owned data.

## Test level selection guide

| Boundary to prove                                                                             | Suite and source location                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Isolated logic, component state, controlled filesystem/process contracts                      | Unit: [unit](unit/)                                                           |
| Database transactions, component wiring, real transport with controlled external dependencies | Integration: [integration](integration/), including [functional](functional/) |
| Authored graph paths and engine/executor contracts                                            | Workflow: [workflow](workflow/)                                               |
| Deployed HTTP admission, status, persistence and authorization                                | API: [api](api/)                                                              |
| Registered MCP schemas, SDK transport and public tool behavior                                | MCP: [mcp-tools](mcp-tools/)                                                  |
| Browser interaction, layout, focus, navigation and rendered language                          | E2E: [e2e](e2e/)                                                              |

Choose the lowest level that observes the required behavior. Add another level when it protects a
different boundary: validation edge cases, HTTP refusal and visible form recovery are different
contracts. Do not repeat the same input table everywhere. A screenshot proves rendered state;
an intercepted browser response does not prove the backend effect. Scenario fixtures do not
establish independent agent judgment or external delivery.

## Writing and maintaining tests

Check the [coverage map](COVERAGE-MAP.md) before adding a suite. Name files for behavior:
`*.test.ts`, `*.test.tsx` or `*.test.cjs` under the supported Jest family; browser files use
`*.spec.ts`. Follow the actual [discovery configs](docs/test-infrastructure.md#discovery-and-preparation).
Update the map when responsibility or suite location changes; describe the boundary without
copying each assertion.

Reuse existing fixtures in `helpers/`, `utils/`, `fixtures/` and `e2e/helpers/` before creating a
new mechanism. Own temporary directories, listeners, processes, clients and test records, and
release them in cleanup even after an assertion fails. Abort event streams and await reader
closure. Do not globally change cwd or remove another run's backups. Workflow CLI subprocess
tests use [workflow-cli-fixture](helpers/workflow-cli-fixture.ts), whose owned cwd contains inputs,
auxiliary files and backups.

Assertions must distinguish a correct result from a plausible wrong result. Avoid no-op or
conditional assertions, empty stubs and copies of the production algorithm. Use concrete expected
values, meaningful failure cases and parameterized input tables. For object-preservation contracts
assert identity; for storage contracts inspect persisted representation.

Measure bounded synchronous work with [CPU time](utils/cpu-time.ts); loaded-machine wall time
does not isolate algorithm cost. Use controlled clocks for deadline behavior. Diagnose the source
of a timeout before changing its limit. Test failures caused by shared state need isolation, not
repeated runs until green.

## Focused guides

- [Infrastructure](docs/test-infrastructure.md): discovery, setups, target routing, artifacts and result guards.
- [Browser tests](docs/e2e-testing.md): fixtures, authentication, prerequisites and browser evidence.
- [API and MCP](docs/api-mcp-testing.md): HTTP sessions, SDK clients and replay-safe execution helpers.
- [Workflow scenarios](docs/workflow-scenarios.md): authored schemas, loops and coverage limits.
- [Troubleshooting](docs/troubleshooting.md): diagnosis before rerunning.

## Native and provider acceptance

The [workspace coverage map](COVERAGE-MAP.md#codespace-connections) distinguishes controlled
process/Unix/SDK/HTTP/browser fixtures from physical VM and provider acceptance. Preserve that
distinction in reports. A skip or unavailable prerequisite is not a pass.

`npm run workspace:verify:guest` builds and packages the common service, then runs its installed
Linux daemon/CLI, renderer and extension closure in a network-disabled pinned container. The image
must already be available locally. This checks startup, ownership, repository preparation,
exact bytes, sessions, publication and restart collection; it does not establish live GitHub,
vendor delivery or physical sbx isolation.

Real sbx acceptance requires an explicitly approved disposable profile and repository on the
supported platform described in [workspace documentation](../docs/reference/workspaces.md#local-runtime). Verify mountless
creation, usable guest Docker, exit/output and byte integrity, sessions/files across stop/start,
continued work under ordinary live settings, and explicit disable/stop/emergency shutdown with
settled ownership. Check absence of host file, credential and socket forwarding; classify documented
public placeholder variables before treating their names as credential exposure.

Physical network evidence needs reachable controlled receivers, positive host-side controls and
guest probes for host, LAN, VPN, metadata and other-VM destinations, alongside successful approved
broker egress. Policy lookup or an unreachable receiver cannot prove packet isolation. Record each
unavailable receiver class as unexecuted. Controlled authority clocks do not prove days of elapsed
native operation. Native APFS storage cases require Darwin and their explicit
`MOIRA_LOCAL_NATIVE_STORAGE_TESTS=1` opt-in.
Persistent work permission does not waive finite provider or parent credential expiry.

Private Git delivery acceptance uses the supported companion and trusted owner broker with an
approved disposable private repository: empty-remote first push, feature push, typed PR
create/find/get, denied foreign repository/permission, and original collection after a lost reply
without credential exposure or repeated effects. Verify provider-confirmed revocation separately
from local access removal. Controlled subprocess/HTTP fixtures and a
network-disabled guest cannot certify external account, installation or provider acceptance.

## Analyzing failures

Read the Markdown failure report under `test-results/artifacts/failures/<suite>/` first. For
preparation, teardown, crashes or missing execution, inspect the executor log and aggregated
outcome; a successful raw JSON file alone is insufficient. The
[result guard](docs/test-infrastructure.md#how-it-works) enforces that distinction.

Preserve relevant artifacts before another run of the same suite. Diagnose the failure, run the
smallest relevant case, then broaden only for a concrete remaining risk. Workflow coverage reports
help locate gaps; full logs remain useful for runtime or infrastructure failures. Do not publish
credential-bearing environment values, request traces or OAuth logs.

For browser timing issues, `E2E_CPU_THROTTLE` in the shared fixture can reproduce slower execution.
Diagram tests wait for the actual settled state through `e2e/helpers/diagram.ts`; sample related
geometry facts in one browser evaluation when motion can change them between reads. See
[troubleshooting](docs/troubleshooting.md) for target, database and authentication diagnosis.
