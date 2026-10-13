# MCP Moira Testing Guide

## Quick Start

### Running Tests

```bash
# Docker tests
npm test                          # All tests
npm run test:api                  # API tests
npm run test:mcp-tools            # MCP tools tests
npm run test:e2e                  # E2E browser tests

# No Docker dependency
npm run test:unit                 # Unit and isolated component fixtures
npm run test:integration          # Integration tests (test-integration.db)
```

Use the repository's Node 24 runtime for Testfold. Select a single test file
with its `--file` option after npm's argument separator:

```bash
npm run test:workflow -- --file tests/workflow/engine/template-processor.test.ts
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts
```

E2E runs installation-wide settings writers in `global-settings` before parallel `chromium`
readers. A selected Chromium file also runs the complete dependency project; a selected
global-settings file runs only its matching cases. See [E2E projects](docs/test-infrastructure.md#e2e-projects)
for scheduling and dependency-failure semantics.

For a worktree whose normal CI ports are already occupied, copy `.env.ci` to an ignored local
environment file and set unique `DOCKER_PORT`, `DOCKER_CONTAINER_NAME`, `DOCKER_IMAGE_NAME`,
`MOIRA_HOST` and `STATIC_ARTIFACTS_DOMAIN` values. Run the complete Docker gate with that file and a
separate free self-host port:

```bash
MOIRA_VERIFY_ENV_FILE=.env.verify MOIRA_TEST_SELF_HOST_PORT=3055 npm run verify:docker
```

The gate and its `ci-saas`/`ci` test environments use those selected settings. Without overrides,
they use `.env.ci` and the normal self-host port. Check your local port inventory before assigning
either port; keep the selected file out of Git.

**Docker requirement:**

```bash
npm run docker:restart  # Start Docker
```

### Test Output

**Console shows:**

- Summary: `239 passed, 0 failed, 239 total`
- Failed tests list (if any)
- Output files: `unit.json | unit.log | failures/unit/`

**Artifacts in `test-results/artifacts/`:**

- **JSON:** `unit.json` - structured results
- **Log:** `unit.log` - full console output
- **Failures:** `failures/unit/01-test-name.md` - individual reports
- **Timing:** `unit-timing.txt` - per-test and per-suite timing statistics (top 30 slowest tests, top 15 suites by setup/teardown time). Generated for all Jest categories: `unit-timing.txt`, `integration-timing.txt`, `api-timing.txt`, `mcp-tools-timing.txt`. E2E timing: `e2e-timing.txt`.
- **Coverage:** `coverage/software-development-flow.md` - workflow coverage reports

### Workflow Scenario Test Failures

Scenario tests automatically validate rendered directives for template errors:

- **Unrendered templates**: `{{variable}}`, `{{#if}}` remaining in output
- **Null values**: Literal "null" indicating undefined variable

Example failure:

```
Error: Unrendered template in node 'task' directive: {{undefined_var}}
Error: Suspicious 'null' value in node 'task' directive: "...value is null..."
```

See `tests/unit/workflow-scenarios/directive-validation.test.ts` for validation tests.

When workflow scenario tests fail, the console shows:

```
💡 Workflow scenario tests failed. Read coverage reports (NOT full logs):
   cat test-results/artifacts/coverage/software-development-flow.md
```

**AI agents:** Read coverage `.md` files — they contain:

- Node/branch coverage percentages
- List of unvisited nodes
- Coverage gaps with hints

Do NOT read `unit.log` for workflow tests — it's huge and wastes tokens.

### Database Usage

| Test Type   | Database                     | Notes                                                            |
| ----------- | ---------------------------- | ---------------------------------------------------------------- |
| Unit        | usually in-memory            | Owned temporary filesystem/component fixtures are also supported |
| Integration | `./data/test-integration.db` | Direct code                                                      |
| API/MCP/E2E | `./data/moira.db`            | Docker                                                           |

---

## Detailed Guides

- [Workflow Scenario Testing](docs/workflow-scenarios.md) - testing workflow paths with mock inputs, coverage calculation
- [E2E Testing](docs/e2e-testing.md) - authentication helpers, fixtures, setup vs test architecture
- [API & MCP Testing](docs/api-mcp-testing.md) - OAuth flow, MCP tools, why MCP tests matter
- [Test Infrastructure](docs/test-infrastructure.md) - runners, parsers, output files
- [Troubleshooting](docs/troubleshooting.md) - common errors, debugging steps

---

## Test Categories

### Unit Tests

**Location:** `tests/unit/`
**Purpose:** Test isolated contracts with controlled dependencies; filesystem, subprocess and Unix HTTP fixtures may be real

The root unit runner builds the common workspace daemon, CLI, local bootstrap and guest
proxy through `scripts/build-workspace-service.js`, including filtered runs. No manual
prebuild is required. Each program is compiled before its exclusive temporary file is
synced and atomically renamed into place. Held readers retain the complete original
program. Publication is per file, not a transaction across the payload.

### Integration Tests

**Location:** `tests/integration/`
**Purpose:** Test component interactions with real code, mocked external services

### API Tests

**Location:** `tests/api/`
**Purpose:** Test HTTP endpoints with real requests

The suite asserts the SaaS contract, so the container it targets must run with
`DEPLOYMENT_MODE=saas` (`.env.local.example` ships that; CI's `.env.ci` too). The `local`
environment sets `API_TEST_TARGET=saas`, which skips the two self-host-only files
(`auth/self-host-auth.test.ts`, `capability-boundary-api.test.ts`) exactly as CI does; CI runs
them against a second container started with `DEPLOYMENT_MODE=self-host` on port 3031 through
`npm run test:api:ci -- --file <file>`. To run them locally, start such a container on 3031
(see `.github/workflows/ci.yml`, "Start self-host Docker container") and use the same command.

### MCP Tools Tests

**Location:** `tests/mcp-tools/`
**Purpose:** Test MCP protocol - **critical for all MCP functionality**

### E2E Tests

**Location:** `tests/e2e/`
**Purpose:** Full system tests with browser

### Local companion and workspace service

Use the root runners for focused checks:

```bash
npm run test:unit -- --file tests/unit/workspace-service/service.test.cjs
npm run test:integration -- --file tests/integration/workspace-router.test.ts
npm run test:integration -- --file tests/integration/codespace-mcp-client-flow.test.ts
npm run test:integration -- --file tests/integration/local/runtime-api.test.ts
npm run test:integration -- --file tests/integration/local-codespace-provider.test.ts
```

Host service fixtures require Git and ripgrep; the TLS router fixture also uses OpenSSL
to create its disposable certificate. They use the repository's Node runtime.

The common fixture in `tests/fixtures/workspace-service.cjs` owns a temporary Git
repository, private state and Unix HTTP socket. Service cases observe real commands,
exact binary and Unicode input/output, sessions, guarded files and direct CLI calls.
Restart collects the original request without another effect. Explicit spawn rejection
and actual command completion are distinguished from missing owner proof; surviving
child or descendant effects after a response retain uncertainty. Cancellation never
grants signal authority to a saved foreign PID. Storage faults observe directory/output
sync errors before durable success.

Filesystem cases substitute targets and parents after staging and interrupt real
multi-file publication. Owned recovery restores original bytes and inodes without replay.
Same-content foreign targets or backups preserve every target, stage and backup before
any rollback, including through another restart. These are process-interruption
observations, not power-loss simulations.

The TLS router fixture runs the actual service and outbound adapter in another process.
CONTROL carries call identifiers; each DATA channel pipes one raw HTTP call to the Unix service.
It checks raw binary backpressure, independent calls while a response is unread, reconnect
without replay, pre-dispatch refusal, and authority expiry/revocation closing CONTROL and
DATA without cancelling admitted work. Workspace authority cases use migrated SQLite for
scoped credential rotation, server-owned bootstrap after generation changes and account denial.

The registered MCP fixture combines the real registry, lifecycle authority, attachment
publisher and Unix service. It edits and executes repository code, checks native binary
upload/download and single-use publication, preserves files across restart and refuses
foreign owners. Container-backed MCP cases check the advertised actions, `ws1-` command
identities, strict action forms, setup guidance, normal path-based download and private
attachment delivery through the application origin without a configured provider.

Local integration cases cover lifecycle journals, policy, broker/relay authority, SDK
protocols, credential-store preparation, storage custody and independent shutdown.
SDK and keychain responses are substituted; native guard cases use controlled real
processes and sockets rather than a physical microVM. Darwin custody cases are excluded
on unsupported platforms. Integration setup runs `npm run local:build` before preparing
its migrated database.

Provider and device/relay cases retain repository/device/account/grant authority, exact
create/stop/delete receipts and verified observation times. The host relay handles
lifecycle work; historical command intents and unknown receipts remain untouched and
nonrunnable. Host CLI cases refuse unsupported create, start and raw-request admission
before creating private state. Journal cases check canonical-target serialization,
failure cleanup, receipt reuse and archived bytes without command-output reservations.

Native recovery cases distinguish SDK/Engine custody from guest readiness, preserve
peer state and unknown receipts, and exercise lease expiry, parent loss and emergency
shutdown. Storage fixtures check retained image reattachment, sector/byte sizing,
lost replies and unsafe binding refusal without native disk tools. Broker cases check
all resolved addresses, peer pinning, streaming backpressure, establishment-only timers
and later revocation/lease closure. Network admission has no socket-count or traffic-ledger
workload quota; authority remains mandatory. Local physical budgets and cloud billing
capacity have separate fixtures.

Private attachment storage is a separate publication contract. Its cases observe streamed
bytes, MIME/name/size checks, held-inode/digest validation, source closure, claim ownership,
expiry cleanup and single use. Communication uses independent sources. A real local
multipart receiver checks Telegram transport bytes without sending to Telegram or
certifying that service's filename interpretation.
See [COVERAGE-MAP.md](COVERAGE-MAP.md#codespace-connections) for suite responsibilities.

To check the packaged common service:

```bash
npm run workspace:verify:guest
```

This builds and packages the canonical payload, then exercises its installer, daemon
and CLI in a network-disabled pinned Linux container. It checks actual startup refusal
and readiness, single ownership, repository binding, exact binary/Unicode bytes, files,
sessions, cancellation and restart receipts. The pinned image must already exist locally.
Container compatibility and `npm run verify:docker` do not establish physical sbx
ownership or host/LAN/VPN/metadata/other-VM isolation.

### Real sbx acceptance

Use the supported macOS runtime described in [CODESPACES.md](../docs/CODESPACES.md) with
an explicitly approved disposable profile and repository. Validate usable mountless
creation, guest Docker, command exits and separate output streams, native byte integrity,
session directory/variables and file persistence across stop/start. Lease expiry and local
emergency disable must stop physical work independently of the parent process, retain
data and produce settled ownership before restart. Check that host files, credentials
and SSH sockets are not forwarded; credential-shaped guest variables require classification
against documented public placeholders rather than assuming that their presence means
host forwarding.

For physical network checks, establish controlled receivers and prove host-side reachability
before guest probes. Verify broker egress to a controlled public destination as the positive guest control, then
observe denied host, LAN, VPN, metadata and other-VM access without exposing a personal
service. SDK policy lookup and failure to reach an unavailable target are insufficient
evidence of isolation. Mark an unavailable controlled receiver as not executed and state
the missing target; never convert it into a pass. Keep this native evidence separate from
versioned fixture coverage and from root verification results.

### Production/Staging Tests

```bash
npm run test:e2e:staging          # E2E on staging
npm run test:e2e:prod             # E2E on production
npm run test:api:staging          # API on staging
npm run test:api:prod             # API on production
npm run test:mcp-tools:staging    # MCP on staging
npm run test:mcp-tools:prod       # MCP on production
```

---

## Writing Tests

### File Naming

- Unit/Integration/API/MCP: `*.test.ts`; Node component fixtures and repository
  automation may use `*.test.cjs` to exercise shipped modules directly.
- E2E: `*.spec.ts`

### E2E Import Rule

```typescript
// ✅ CORRECT
import { test, expect } from "./fixtures.js";

// ❌ WRONG
import { test, expect } from "@playwright/test";
```

Use `login` or `loginAsAdmin` from `tests/e2e/helpers/auth-helper.ts` for authenticated browser
scenarios, including translation checks. The helper signs in through the real auth endpoint,
installs its session cookie and sets the beta-acceptance cookie by default. Navigation then uses
ordinary actionable clicks while admission rechecks settle. Tests of the login form itself use
the browser-based auth helper.

### Test Structure

```typescript
describe("Feature Name", () => {
  beforeEach(() => {
    /* Setup */
  });
  afterEach(() => {
    /* Cleanup - ALWAYS */
  });

  test("should do specific thing", async () => {
    // Arrange → Act → Assert
  });
});
```

### Standards

**DO:**

- Descriptive names starting with "should"
- Test success AND failure paths
- Add cleanup in afterEach
- Abort owned event streams and await reader closure in afterEach, including when an
  assertion fails. Wait for the required event kind rather than an arbitrary event count.
- Use utilities from `tests/utils/`

**DON'T:**

- Share state between tests
- Skip cleanup
- Hard-code timeouts without reason
- Test implementation (test behavior)

---

## Test Antipatterns

These antipatterns were found in real project code during audit. Do NOT repeat them.

### A1: No-op Assertions

Assertions that are always true regardless of code behavior.

```typescript
// ❌ WRONG — always passes, tests nothing
test("processes data", () => {
  processData(input);
  expect(true).toBe(true);
});

// ✅ RIGHT — verifies actual result
test("processes data", () => {
  const result = processData(input);
  expect(result.status).toBe("completed");
  expect(result.items).toHaveLength(3);
});
```

### A2: Conditional Assertions

Assertions wrapped in `if` blocks that may never execute.

```typescript
// ❌ WRONG — if element is not visible, test passes with 0 checks
const button = page.locator('[data-testid="submit"]');
if (await button.isVisible()) {
  await expect(button).toHaveText("Submit");
}

// ✅ RIGHT — assertion always executes
await expect(page.locator('[data-testid="submit"]')).toBeVisible();
await expect(page.locator('[data-testid="submit"]')).toHaveText("Submit");
```

### A3: Empty Stub Files

Test files with zero assertions or only `test.todo()` placeholders.

These waste CI time and create false coverage. Either write real tests or delete the file.

### A4: Inline Algorithm Copy

Copying production logic into test to compute expected values.

```typescript
// ❌ WRONG — repeats the regex from production code
test("validates email", () => {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // copied from src/
  expect(regex.test(input)).toBe(validateEmail(input));
});

// ✅ RIGHT — tests known inputs against expected outputs
test("validates email", () => {
  expect(validateEmail("user@example.com")).toBe(true);
  expect(validateEmail("invalid")).toBe(false);
  expect(validateEmail("")).toBe(false);
});
```

### A5: Performance Test Without Assertions

Measuring time but never asserting a threshold.

```typescript
// ❌ WRONG — prints timing but never fails
test("performance", () => {
  const start = Date.now();
  renderDashboard();
  console.log(`Render took ${Date.now() - start}ms`);
});

// ✅ RIGHT — enforces a budget on the work itself
import { cpuTimeMs } from "../utils/cpu-time";

test("performance", () => {
  const { cpuMs } = cpuTimeMs(() => renderDashboard());
  expect(cpuMs).toBeLessThan(500);
});
```

A test that proves synchronous work is bounded (no catastrophic regex backtracking, linear rather
than quadratic) measures the process's CPU time with `tests/utils/cpu-time.ts`, not the wall
clock: on a loaded machine the process waits for a CPU, and that wait fails a wall-clock budget
without saying anything about the code. A deadline or timeout is tested with fake timers instead of
real waiting.

### A6: Copy-Paste Duplication

Two or more tests with >80% identical code that differ only in input values.

```typescript
// ❌ WRONG — repeated setup/assertion logic
test("creates note with title A", async () => {
  await login();
  await navigate("/notes");
  await fill("A");
  await click("Save");
  await expect(page.locator(".note")).toHaveText("A");
});
test("creates note with title B", async () => {
  await login();
  await navigate("/notes");
  await fill("B");
  await click("Save");
  await expect(page.locator(".note")).toHaveText("B");
});

// ✅ RIGHT — parameterized
test.each(["A", "B"])("creates note with title %s", async (title) => {
  await login();
  await navigate("/notes");
  await fill(title);
  await click("Save");
  await expect(page.locator(".note")).toHaveText(title);
});
```

### A7: Cross-Level Redundancy

The same logical check tested at unit, integration, AND e2e levels without added value.

```
Example: slug validation
  unit: validateSlug('x') → false (edge cases)
  integration: POST /workflow {slug:'x'} → 400 (API contract)
  e2e: browser types 'x' → sees error (user experience)

All three are valid ONLY if they test DIFFERENT aspects:
  unit → boundary values, edge cases
  integration → HTTP status codes, error messages, DB constraints
  e2e → UI error display, form behavior
```

If two tests at different levels assert the exact same logic with the same inputs, keep the lower-level one.

---

## Test Level Selection Guide

Use this table to determine the correct test level for new tests.

### Decision Table

| What you're testing                               | Level           | Why                                    |
| ------------------------------------------------- | --------------- | -------------------------------------- |
| Pure function logic, edge cases, validation rules | **unit**        | Fast, isolated, easy to debug          |
| Template processing, expression evaluation        | **unit**        | No external dependencies needed        |
| Error classes, serialization, utilities           | **unit**        | Pure logic                             |
| Repository CRUD (with real DB)                    | **integration** | Tests DB interaction                   |
| Service layer with multiple dependencies          | **integration** | Tests component wiring                 |
| Workflow execution (node transitions, context)    | **workflow**    | Specialized runner for graph scenarios |
| HTTP endpoint request/response                    | **api**         | Tests real HTTP contract               |
| MCP tool input/output via protocol                | **mcp-tools**   | Tests MCP protocol compliance          |
| User workflow through browser                     | **e2e**         | Tests real user experience             |
| Visual UI state (modals, navigation, i18n)        | **e2e**         | Needs real browser rendering           |

### Level Selection Rules

1. **Start at the lowest possible level.** If unit test covers it — use unit test.
2. **Move up only when the lower level cannot test the interaction.** DB queries need integration. HTTP contracts need API tests.
3. **E2E is for user-visible behavior only.** Don't use E2E to test business logic that a unit test covers.
4. **One assertion per concern per level.** If unit tests cover slug validation edge cases, API test only needs to verify the endpoint rejects invalid slugs (one test, not all edge cases again).

### Cross-Level Coverage Checklist

Before writing a test, check `tests/COVERAGE-MAP.md`:

1. Does this domain already have tests at my chosen level?
2. Am I duplicating a check that exists at a lower level?
3. Does my test add NEW coverage (different aspect, different level of abstraction)?

If the answer to #2 is "yes" and #3 is "no" — don't write the test.

---

## Analyzing Failures

A successful raw JSON report alone does not establish a passing run. Inspect the aggregated
runner outcome and executor log when preparation, teardown or process completion fails; the
[framework result guard](docs/test-infrastructure.md#how-it-works) distinguishes those failures
from executed test assertions.

1. **Read `.md` failure reports first** - clean error messages
2. **Read `.log` if tests crash** - full console output
3. **Analyze database** if needed
4. **Fix and verify** with specific test run

```bash
cat test-results/artifacts/failures/e2e/01-test-name.md
sqlite3 ./data/moira.db "SELECT * FROM user;"
npm run test:e2e -- --file tests/e2e/specific-test.spec.ts
```

**A failure that appears only in CI** (the nightly E2E runs on a Linux runner far slower than a
developer machine) usually depends on timing. Reproduce it locally by slowing the browser's CPU with
`E2E_CPU_THROTTLE`, which every E2E page applies through the shared fixture (Chrome DevTools CPU
emulation; a rate around 8 reproduces the runner), and repeat the spec without retries:

```bash
E2E_CPU_THROTTLE=8 npm run test:e2e -- --file tests/e2e/flow-page.spec.ts -- --retries=0 --repeat-each=3
```

Fix what the slowness exposes; do not raise a timeout. A spec acting on a diagram waits for the
diagram's `data-diagram-settled="true"` (`settledCamera` in `tests/e2e/helpers/diagram.ts`), never
for a camera value that a second layout pass or an animated placement can still change.

For a phone guide's dock/geometry assertion, sample `data-guide-dock` and its bounding rectangle
inside one `locator.evaluate` call. Separate browser reads can observe different top/bottom
placements while target reveal or entrance motion changes the card.

---

## Quick Reference

```bash
# Run tests
npm test
npm run test:unit
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts

# Analyze failures
cat test-results/artifacts/failures/e2e/01-test-name.md
cat test-results/artifacts/e2e.log

# Database
sqlite3 ./data/moira.db "SELECT * FROM user;"

# Docker
npm run docker:restart
docker ps | grep moira
```

**Critical Rules:**

- ONLY use npm commands (not direct jest/playwright)
- E2E tests MUST import from `./fixtures.js`
- Clean up in afterEach ALWAYS
- Read failure `.md` files first (not logs)
