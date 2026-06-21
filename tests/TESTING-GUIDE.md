# MCP Moira Testing Guide

## Quick Start

### Running Tests

```bash
# Docker tests
npm test                          # All tests
npm run test:api [path]           # API tests
npm run test:mcp-tools [path]     # MCP tools tests
npm run test:e2e [path]           # E2E browser tests

# No Docker dependency
npm run test:unit [path]          # Unit tests (in-memory)
npm run test:integration [path]   # Integration tests (test-integration.db)
```

**Path argument:** Full path or just filename

```bash
npm run test:unit template-processor.test.ts
npm run test:e2e admin-panel.spec.ts
```

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

| Test Type   | Database                     | Notes       |
| ----------- | ---------------------------- | ----------- |
| Unit        | in-memory                    | No file     |
| Integration | `./data/test-integration.db` | Direct code |
| API/MCP/E2E | `./data/moira.db`            | Docker      |

---

## Detailed Guides

- [Workflow Scenario Testing](docs/workflow-scenarios.md) - testing workflow paths with mock inputs, coverage calculation
- [E2E Testing](docs/e2e-testing.md) - authentication helpers, fixtures, setup vs test architecture
- [API & MCP Testing](docs/api-mcp-testing.md) - OAuth flow, MCP tools, why MCP tests matter
- [Test Infrastructure](docs/test-infrastructure.md) - runners, parsers, output files
- [Troubleshooting](docs/troubleshooting.md) - common errors, debugging steps

---

## Test Categories

### 1. Unit Tests

**Location:** `tests/unit/`
**Purpose:** Test components in isolation, mock all dependencies

### 2. Integration Tests

**Location:** `tests/integration/`
**Purpose:** Test component interactions with real code, mocked external services

### 3. API Tests

**Location:** `tests/api/`
**Purpose:** Test HTTP endpoints with real requests

### 4. MCP Tools Tests

**Location:** `tests/e2e/mcp-tools/`
**Purpose:** Test MCP protocol - **critical for all MCP functionality**

### 5. E2E Tests

**Location:** `tests/e2e/`
**Purpose:** Full system tests with browser

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

- Unit/Integration/API/MCP: `*.test.ts`
- E2E: `*.spec.ts`

### E2E Import Rule

```typescript
// ✅ CORRECT
import { test, expect } from "./fixtures.js";

// ❌ WRONG
import { test, expect } from "@playwright/test";
```

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

// ✅ RIGHT — enforces a performance budget
test("performance", () => {
  const start = Date.now();
  renderDashboard();
  expect(Date.now() - start).toBeLessThan(500);
});
```

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

1. **Read `.md` failure reports first** - clean error messages
2. **Read `.log` if tests crash** - full console output
3. **Analyze database** if needed
4. **Fix and verify** with specific test run

```bash
cat test-results/artifacts/failures/e2e/01-test-name.md
sqlite3 ./data/moira.db "SELECT * FROM user;"
npm run test:e2e specific-test.spec.ts
```

---

## Quick Reference

```bash
# Run tests
npm test
npm run test:unit
npm run test:e2e admin-panel.spec.ts

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
