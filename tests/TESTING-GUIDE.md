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

The root unit runner builds the common workspace programs through
`scripts/build-workspace-service.js`, including filtered runs. Unit global setup also
compiles the host-native process custody and runtime-control helpers through
`scripts/build-local-native.js`. No manual prebuild or release packaging is required.
Each workspace program is compiled before its exclusive temporary file is
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
npm run test:unit -- --file tests/unit/workspace-service/semantic-owner.test.cjs
npm run test:unit -- --file tests/unit/workspace-service/cli-native.test.cjs
npm run test:unit -- --file tests/unit/workspace-service/native-publication.test.cjs
npm run test:unit -- --file tests/unit/local/controller.test.ts
npm run test:unit -- --file tests/unit/local/controller-state.test.ts
npm run test:integration -- --file tests/integration/workspace-router.test.ts
npm run test:integration -- --file tests/integration/codespace-mcp-client-flow.test.ts
npm run test:integration -- --file tests/integration/local/runtime-api.test.ts
npm run test:integration -- --file tests/integration/local-codespace-provider.test.ts
npm run test:integration -- --file tests/integration/local-device-control.test.ts
```

Host service fixtures require Git and ripgrep; the TLS router fixture also uses OpenSSL
to create its disposable certificate. They use the repository's Node runtime.

Discovery tests distinguish provider independence with deliberately unresolved GitHub,
installation and billing reads while selected Local discovery completes. The provider and
private-repository integrations check shared request-local observations, current registration
fences, actionable known setup, diagnostic originals without lifecycle generations and retained
history. Frontend settings tests check separate provider/view completion, lazy billing on the
GitHub subsection, and rejection of late success or failure after same-account credential or
capability changes. Browser scenarios exercise the current-view controls and original collection;
these controlled responses do not prove live external provider availability.

The common fixture in `tests/fixtures/workspace-service.cjs` owns a temporary Git
repository, private state and Unix HTTP socket. Service cases observe real commands,
exact binary and Unicode input/output, sessions, guarded files and direct CLI calls.
Restart collects the original request without another effect. Explicit spawn rejection
and actual command completion are distinguished from missing owner proof; surviving
child or descendant effects after a response retain uncertainty. Cancellation never
grants signal authority to a saved foreign PID. Storage faults observe directory/output
sync errors before durable success.

Semantic owner and CLI cases use purpose-specific inputs and returned operation/process/file
references over that same socket. They distinguish a concurrent text or inode replacement from
the caller's captured file version, reject ambiguous/overlapping text patches, and preserve
Cyrillic/emoji through complete-character file, initial command and output continuation windows.
Discovery reads safe intent metadata without collecting candidates or exposing their result
payloads. Explicit collection retains the original outcome; a lost first reply leaves candidates
for explicit selection rather than authorizing resubmission. Two deliberately identical new calls
remain separate intentions.

Filesystem cases substitute targets and parents after staging and interrupt real
multi-file publication. Owned recovery restores original bytes and inodes without replay.
Same-content foreign targets or backups preserve every target, stage and backup before
any rollback, including through another restart. These are process-interruption
observations, not power-loss simulations.

The TLS router fixture runs the actual service and outbound adapter in another process.
CONTROL carries call identifiers; each DATA channel pipes one raw HTTP call to the Unix service.
It checks raw binary backpressure, independent calls while a response is unread, reconnect
without replay, pre-dispatch refusal, and authority expiry/revocation closing CONTROL and
DATA without cancelling admitted work. Controller and guest connections have separate
endpoint identities; trusted routing headers replace caller-supplied authority, and controller
routing does not start a guest. Workspace authority cases use migrated SQLite for scoped
credential rotation, current Local route/device authority and account denial. GitHub bootstrap
remains a separate provider responsibility.

The registered MCP fixture combines the real registry, lifecycle authority, attachment
publication owner and Unix service. It edits and executes repository code, checks native binary
upload/download and repeatable immutable publication, preserves files across restart and refuses
foreign owners. Container-backed MCP cases check the advertised purpose tools, strict semantic
schemas, setup guidance, path-based download defaults and original-operation communication
refusal/collection through the application origin without a configured provider. Private owner
protocol tests retain their internal request identities; ordinary adapters do not ask callers to
manufacture them.

Local integration cases cover owner lifecycle receipts, policy, broker/device authority, SDK
protocols, credential-store preparation, storage custody and independent shutdown.
SDK and keychain responses are substituted; native guard cases use controlled real
processes and sockets rather than a physical microVM. Darwin custody cases are excluded
on unsupported platforms. Integration global setup builds the host Local programs with
`scripts/build-local-programs.js`, native helpers with `scripts/build-local-native.js`,
and the controller's owner programs with `scripts/build-workspace-service.js` before
preparing its migrated database. Controller rendering uses the installed npm dependencies.
This preparation does not download or package
guest archives, GitHub CLI toolchains, fonts or renderer dependencies; complete release
packaging remains part of the packaged guest verifier below.

The hosted CI integration job uses a byte-verified private copy of Node with mode `0700`.
This satisfies the supervisor's executable ownership and permission checks without changing
the shared runner toolcache or weakening the product's custody policy.

The real private Unix controller owns Local lifecycle and settings effects. Provider and
browser-authorized settings routes retain repository/device/account/grant authority and
collect the caller's original `ws1-` request after a lost reply without another effect.
Lifecycle requests carry the observed owner generation; settings carry the owner revision.
Stale generations are refused, while stable route authority remains separate from lifecycle
generation fencing. Live views preserve the admitted VM profile when defaults for new VMs change.
Owner receipts expose unresolved request IDs for collection after reload. Cloud storage
retains minimal authentication/routing metadata; migration cases preserve retired control,
relay and operational rows in inaccessible archives without replay.

Local storage checks inspect the actual `localResourceIdentity` columns and the absence
of the active `codespaceResource` table, rather than inferring minimal storage from an
unchanged public response. Populated migration cases compare complete archived rows,
approved device bindings and existing guest credentials. Changed owner defaults must
appear on a newly admitted VM while an existing VM keeps its admitted profile and
unchanged stored route; an offline owner must not certify historical SQL state.
Original uncertain creation receipts retain their
request/device/resource identities on repeated collection without another native effect.
Account-deletion cases distinguish confirmed resource retirement from access revocation:
a revoked binding with unresolved disk custody must still prevent metadata deletion.

The browser fixture pairs and confirms its own device but does not connect a controller.
It checks honest offline state, absence of effective settings, pre-admission write refusal
and the same unavailable state after reload. Separate mocked owner responses exercise the rendered
English/Russian enabled, disabled, pending, rejected and unavailable cards, including persistent
permission without expiry controls. Setup cards distinguish explicit same-VM resume and its
preserved-root remedy, usable local work with unavailable enrollment or transport, and unknown
creation with collection only. Those images establish UI behavior, not physical settings or VM effects.
UI unit cases separately check retained drafts,
actual applied consent, captured lifecycle/delete preconditions and original-operation recovery.
Lost-first-reply cases keep explicit candidate selection even for one match; an absent original
does not unblock resubmission. Neither fixture claims a complete browser
settings effect on a physical VM.

Host CLI cases refuse unsupported raw requests before creating private state. Supported
create/start against an initialized but unpaired owner refuse without SDK contact or state
changes. A new host-owned creation requires checked cloud route registration and initial
Git authority; transport loss does not revoke an existing paired owner's locally admitted
work. Journal cases check canonical-target serialization, failure cleanup and private
custody; controller receipt cases cover durable original-ID collection and uncertainty
after restarting an accepted request without replay.
Host CLI cases also distinguish safe metadata discovery from full explicit collection and retain
typed delivery uncertainty across both. Privileged maintenance/security collection uses the
existing receipts and issuer collector: offline live custody and maintenance are readable, unknown
IDs are locally absent without raw lifecycle fallback, issuer failure remains unconfirmed, and
recovered-child disposal never becomes another issuance or Git effect.

Provider/controller cases exercise setup resume on the same known runtime while retaining the
failed original create receipt; unknown creation and custody recovery remain separate.
Host orchestration fixtures use the real owner and private records with controlled runtime/cloud
boundaries. They distinguish stopped initial-UNKNOWN acknowledgement from completed setup, then
resume the same VM. Held credential/optional-author responses do not block local readiness or
validation; generation, authority, revocation, stop and release changes reject stale enrollment.
These fixtures do not establish native SDK recovery or an installed-owner update.
Native recovery cases distinguish SDK/Engine custody from guest readiness, preserve
peer state and unknown receipts, and exercise persistent permission, parent loss and emergency
shutdown. Storage fixtures check retained image reattachment, sector/byte sizing,
lost replies and unsafe binding refusal without native disk tools. Broker cases check
all resolved addresses, peer pinning, streaming backpressure, establishment-only timers
and later grant revocation or explicit disable. Network admission has no socket-count or traffic-ledger
workload quota; authority remains mandatory. Local physical budgets and cloud billing
capacity have separate fixtures.

Native APFS resize coverage requires Darwin and the explicit
`MOIRA_LOCAL_NATIVE_STORAGE_TESTS=1` opt-in. Unsupported-platform and unrequested physical
cases are skips, not proof of native storage behavior. Controlled process/socket and storage
fixtures do not replace the disposable real-VM acceptance below.

Owner communication fixtures distinguish source acquisition before admission from retained delivery uncertainty. The common service cases observe original-ID submit/collect, per-channel stages, source consumption and physical settlement, scope changes, separate long-message stages and no resend after a lost result. Framing cases exercise large Unicode control, coalesced prefix/file chunks and cancellation of a held original read. Actual HTTP refusal/replay fixtures require the complete known response before unread ingress closes.

Native publication cases exercise successful semantic `file_upload` and `command_run_native`
through the existing isolated source fixture. They compare exact binary bytes, discover and collect
a lost upload reply after source refusal without reacquisition, and collect command stdin results
across restart without a duplicate effect. This is controlled source transport evidence, not live
ChatGPT attachment networking. Shared receipt-state cases distinguish typed credential/vendor
uncertainty from confirmed refusal while leaving private stored receipts unchanged.

`tests/integration/extension-owner.test.ts` exercises a real compiled installed binary handler, immutable artifact admission, demand-driven byte pipes, held vendor/source work and supervised completion. Fixed transport fixtures verify declared endpoint/recipient/secret authority, exact raw/multipart file bytes and early vendor completion without real provider sends. Migration fixtures compare the complete immutable transfer/grant archives and preserve retained bytes without replay.

Progress tests retain run/context/task/version guards, explicit owner-unavailable MCP/HTTP errors and positive PNG rendering through a real owned publication fixture. `workspace:verify:guest` additionally executes the shipped renderer with its private native/font closure and packaged extension handler in the network-disabled guest. These observations do not certify real Telegram delivery or live GitHub compatibility. Text/PIN/reminder tests remain independent of a file owner.

See [COVERAGE-MAP.md](COVERAGE-MAP.md#codespace-connections) for suite responsibilities.

To check the packaged common service:

```bash
npm run workspace:verify:guest
```

This builds and packages the canonical payload, then exercises its installer, daemon
and CLI in a network-disabled pinned Linux container. It checks actual startup refusal
and readiness, single ownership, repository binding, exact binary/Unicode bytes, files,
sessions, cancellation and restart receipts. Setup scenarios exercise owned-stage continuation,
exclusive publication without replacing occupied targets, and preserved repository/user contents.
They distinguish usable Unix commands from unavailable cloud authority, automatic transport
reconnection and later configuration reload into the same owner without replaying accepted work.
The verifier uses the ordinary semantic CLI and tools, checked text references, complete UTF-8
windows and binary streaming. Native source networking, real GitHub provisioning and actual vendor
delivery are outside this network-disabled check. The pinned image must already exist locally.
Container compatibility and `npm run verify:docker` do not establish physical sbx
ownership or host/LAN/VPN/metadata/other-VM isolation.

### Real sbx acceptance

Fixed Git and pull-request fixtures exercise the shared owner broker with controlled TLS/HTTP
endpoints, exact repository/action authority, physical upstream closure and original PR receipt
collection. Actual CLI subprocess cases distinguish a confirmed source refusal from retained
credential custody/disposal uncertainty and an unknown post-dispatch PR effect, preserving both
recovery identities without redispatch. Migrated issuer/account cases check encrypted candidate
custody, original security collection without mint, retirement cutoffs and retention of unresolved
credentials/resources before account cascade. These fixtures do not prove live GitHub permissions.

The packaged Linux guest check also observes the actual GH daemon's inherited kernel lock,
competing-lock refusal while the owner lives, and process absence plus lock availability after
stop. Its network-disabled container cannot certify direct private GitHub fetch/push or PR delivery.
External acceptance uses an approved disposable repository/branch and the trusted owner broker:
verify private read/write, another-repository and wrong-permission refusal, original-ID recovery
after a lost release response, and provider-confirmed revocation without repeating Git effects.
Local physical VM/network acceptance remains separate below.

Use the supported macOS runtime described in [CODESPACES.md](../docs/CODESPACES.md) with
an explicitly approved disposable profile and repository. Validate usable mountless
creation, guest Docker, command exits and separate output streams, native byte integrity,
session directory/variables and file persistence across stop/start. Permission remains enabled
without a work deadline; controlled authority clocks distinguish that contract from finite credential
expiry. Explicit local disable must stop physical work independently of the client process, retain
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
