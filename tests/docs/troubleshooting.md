# Test troubleshooting

Start with the [testing guide](../TESTING-GUIDE.md#analyzing-failures). Preserve the current
artifacts before another invocation replaces them. Rerun to test a diagnosis, not to erase a failure.

## No tests or apparent success after a crash

Check the selected path against the [discovery config](test-infrastructure.md#discovery-and-preparation).
Read the executor log for compilation, global setup, teardown and process-exit failures. An empty
or skipped-only report is not an executed pass. The
[result guard](test-infrastructure.md#how-it-works) treats these as infrastructure failures even
when a framework JSON file appears successful.

## Target unavailable or wrong deployment behavior

Confirm which Testfold environment the command selected and whether the expected target is
running. Check health at that configured target. Do not assume a default port or restart an
unrelated installation. Local Docker and remote browser/Node transports have separate routing;
see [target selection](test-infrastructure.md#target-selection).

API SaaS exclusions and self-host checks protect different deployment contracts. A pass against
one mode does not establish the other. For paired CI-equivalent container preparation use
`npm run verify:docker` with the intended isolated environment.

Inspect whether required variables are configured without printing their values. Never dump ADMIN
credentials, tokens, private environment files or full OAuth traces into a report.

## Database locked

Identify the database owner first. Integration suites use their migrated test database and run
files sequentially; API/MCP/browser suites use the selected server's storage; component fixtures
may own a temporary database. Check leaked connections, concurrent writers and cleanup at that
boundary. Restarting Docker cannot repair an unrelated local test database or missing disposal.
Retain WAL and transaction semantics when fixing contention.

## Authentication or MCP refusal

Use the existing [browser helpers](e2e-testing.md#fixtures-and-authentication) or
[HTTP/SDK helpers](api-mcp-testing.md). Email verification and deployment account approval are
separate. Confirm whether the caller needs a cookie value, Cookie header or SDK bearer transport.
Dedicated credential-mutation accounts must not alter the shared administrator.

For an unknown tool or rejected field, inspect the current typed tool catalog and actual SDK
response. Refresh/reconnect a stale client when appropriate; do not bypass admission or invent an
old tool name. Use `execution` with `action: "current_step"` to inspect the current presentation,
then reconcile the intended answer. A changed continuation surface requires explicit `diagnose`
and authorized `recover` on that same execution; current-step inspection cannot bypass that guard.
Do not replay an obsolete input. Preserve unknown external outcomes and collect the original operation instead
of submitting it again.

## Timeout or unstable browser state

Read the failed action and observable state before changing selectors or timeouts. Separate slow
setup, a blocked request, shared-state leakage and a true deadline. Use controlled clocks for timer
behavior and CPU time for synchronous work. A larger timeout does not establish correctness.

Browser fixtures support `E2E_CPU_THROTTLE` for slower rendering. Wait for the actual request,
dialog, focus or settled diagram state. Keep related geometry facts in one browser sample when
motion can change them. See [browser testing](e2e-testing.md#run-and-inspect).

For scenario loops, inspect schema-valid inputs, node-local/global scope, visits and cycle
diagnostics using the [scenario guide](workflow-scenarios.md). Its coverage report has explicit
measurement limits and does not replace scenario assertions.
