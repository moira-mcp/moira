# Testing Guidelines

## Critical Requirements

### NO Hardcoded URLs or Ports

**RULE:** All integration and E2E tests MUST use `getTestBaseUrl()` utility.

**Rationale:**

- Tests run on Docker local build by default (localhost:DOCKER_PORT from .env.local)
- Same tests can run on production (https://example.com)
- Multi-worktree development with different Docker ports (master=3030, dev=3031, dev2=3032, dev3=3033)

**Violation:**

```typescript
// ❌ WRONG - hardcoded URL
await fetch("http://localhost:3030/api/workflows");
await page.goto("http://localhost:3030/login");
```

**Correct:**

```typescript
// ✅ CORRECT - use utility
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
await fetch(`${BASE_URL}/api/workflows`);
await page.goto(`${BASE_URL}/login`);
```

---

## Test Base URL Resolution

**Utility:** `tests/utils/test-config.ts`

```typescript
export function getTestBaseUrl(): string {
  // Priority 1: Explicit override
  if (process.env.TEST_BASE_URL) {
    return process.env.TEST_BASE_URL;
  }

  // Priority 2: Docker port from .env
  const dockerPort = process.env.DOCKER_PORT || "3032";
  return `http://localhost:${dockerPort}`;
}
```

**Usage:**

```bash
# Default: Docker local (reads DOCKER_PORT from .env.local)
npm test
npm run test:e2e:docker

# Custom Docker port
TEST_BASE_URL=http://localhost:3031 npm test

# Production
TEST_BASE_URL=https://example.com npm test
```

---

## Test Types

### Integration Tests (Jest)

**Location:** `tests/integration/`
**Target:** Docker local build by default
**Utility:** Use `getTestBaseUrl()` for all HTTP requests

**Example:**

```typescript
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("API endpoint works", async () => {
  const res = await fetch(`${BASE_URL}/api/workflows`);
  expect(res.status).toBe(200);
});
```

### Integration API Tests (Jest)

**Location:** `tests/integration-api/`
**Target:** REST API endpoints via Docker local build
**Auth:** Cookie-based session authentication

**Example:**

```typescript
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

beforeAll(async () => {
  const signinResponse = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@moira.local",
      password: "AdminTest123",
    }),
  });

  const cookies = signinResponse.headers.get("set-cookie");
  authCookie = cookies;
});

test("POST /api/workflows defaults to private visibility", async () => {
  const response = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
    },
    body: JSON.stringify({
      id: workflowId,
      workflow: {
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test description",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
    }),
  });

  expect(response.status).toBe(201);
  const data = await response.json();
  expect(data.workflow.visibility).toBe("private");
});
```

**Test Files:**

- `user-profile-api.test.ts`: User profile management endpoints (12 tests)
  - GET /api/user/profile (authenticated + unauthenticated)
  - PATCH /api/user/profile (name update + validation)
  - POST /api/user/change-password (password change + validation + verification)
  - POST /api/user/resend-verification (email verification)

### E2E Tests (Playwright)

**Location:** `tests/e2e/`
**Target:** Docker local build by default
**Utility:** Use `getTestBaseUrl()` for all page.goto() calls

**Example:**

```typescript
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("Login page renders", async ({ page }) => {
  await page.goto(`${BASE_URL}/app/login`);
  await expect(page).toHaveTitle(/MCP Moira/);
});
```

**Test Files:**

- `user-profile.spec.ts`: User profile and security management (9 tests)
  - Profile page loading with user data
  - Name editing and validation (max 100 characters)
  - Email verification status display
  - Security tab password change form
  - Password validation (matching, minimum length)
  - Password strength indicator
  - Complete password change workflow

**Authentication Helper:**

Centralized E2E authentication in `tests/e2e/helpers/auth-helper.ts`:

```typescript
import { loginAsAdmin } from "./helpers/auth-helper.js";

test("protected page", async ({ page }) => {
  await loginAsAdmin(page);
  // Test authenticated functionality
});
```

Functions:

- `login(page, email, password, autoAcceptBeta)` - Universal login
- `loginAsAdmin(page, autoAcceptBeta)` - Admin login shortcut
- `loginAsMcpToolsTest(page, autoAcceptBeta)` - MCP tools test user
- `acceptBetaAgreement(page)` - Accept beta modal
- `declineBetaAgreement(page)` - Decline and logout
- `dismissBanner(page)` - Dismiss beta warning banner

Default `autoAcceptBeta=true` handles beta agreement modal automatically.

### Unit Tests (Jest)

**Location:** `tests/unit/`
**Target:** No HTTP requests, no BASE_URL needed
**Focus:** Pure functions, business logic, utilities

### Workflow Scenario Tests (Jest)

**Location:** `tests/workflow/scenarios/`
**Target:** Workflow execution paths via GraphExecutionEngine
**Focus:** Validating workflow structure, execution paths, node/branch coverage

**Components:**

- `tests/helpers/scenario-runner.ts` - Runs scenarios via GraphExecutionEngine (supports `maxRetries`/`maxRetriesExceeded` node redirects, excludes Go/Docker format strings like `{{.Names}}` from template validation, accepts `engineSetup` callback for handler customization)
- `tests/helpers/coverage-calculator.ts` - Calculates node/branch coverage
- `GraphValidator` from `@mcp-moira/workflow-engine` - Validates workflow structure

**Test Files:**

Each production workflow has a corresponding scenario test file (e.g. `quick-task.test.ts`, `content-creation.test.ts`, `development-workflow.test.ts`). Each file contains structural validation tests and scenario coverage tests targeting 100% node and branch coverage.

**Example:**

```typescript
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";

const scenario: TestScenario = {
  name: "happy-path",
  description: "User completes task successfully",
  mockInputs: {
    "task-input": { task: "Fix bug" },
    "user-approval": { approved: "yes" },
  },
  expect: {
    status: "completed",
    reaches: ["end"],
    avoids: ["error-handler"],
  },
};

test("happy path reaches end", async () => {
  const result = await runScenario(workflow, scenario);
  expect(result.passed).toBe(true);
});
```

**Coverage Analysis:**

```typescript
import { calculateCoverage } from "../../helpers/coverage-calculator.js";

const coverage = calculateCoverage(workflow, allScenarioResults);
// coverage.nodeCoverage: number (percentage)
// coverage.branchCoverage: number (percentage)
// coverage.unvisitedNodes: string[]
// coverage.untestedBranches: Array<{nodeId, branch}>
```

**Testing Workflows with Note Nodes:**

Workflows using `write-note`, `upsert-note`, or `read-note` nodes require NoteService (database). Use the `engineSetup` option to inject mock NoteService into handlers:

```typescript
import { WriteNoteHandler, ReadNoteHandler } from "@mcp-moira/workflow-engine";

const mockNoteService = {
  exists: async () => false,
  save: async () => ({ id: "mock-id", version: 1 }),
  list: async () => ({ notes: [], total: 0, allTags: [] }),
  get: async () => ({
    id: "id",
    key: "k",
    tags: [],
    value: "{}",
    size: 2,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
} as any;

const result = await runScenario(workflow, scenario, {
  engineSetup: (engine) => {
    const handlers = (engine as any).nodeHandlers as Map<string, any>;
    handlers.set("write-note", new WriteNoteHandler(mockNoteService));
    handlers.set("read-note", new ReadNoteHandler(mockNoteService));
  },
});
```

---

## Running Tests

### Docker Tests

```bash
npm run docker:restart        # Build and run Docker
npm test                      # All tests
npm run test:api              # API tests
npm run test:mcp-tools        # MCP tools tests
npm run test:e2e              # E2E browser tests
```

### No Docker Dependency

```bash
npm run test:unit             # Unit tests (in-memory)
npm run test:integration      # Integration (test-integration.db)
```

### External target

```bash
TEST_BASE_URL=https://your-instance.example.com npm test   # run against a deployed instance
```

---

## Test File Header Template

**All integration/E2E tests MUST include this header:**

```typescript
/**
 * [Test Suite Name]
 * [Description]
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env.local)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
```

---

## Writing New Tests

### Test File Naming

**RULE:** Name test files by **what they verify**, not by step numbers.

**Bad (step-based naming):**

```
❌ stage-8-verification.test.ts
❌ step-3-validation.test.ts
❌ test-phase-2.test.ts
```

**Good (semantic naming):**

```
✅ workflow-execution.test.ts       // Tests workflow execution flow
✅ user-authentication.test.ts      // Tests auth functionality
✅ project-checklist.test.ts        // Tests checklist validation
✅ api-rate-limiting.test.ts        // Tests rate limiting
```

**Rationale:**

- Tests are read more often than written
- Step numbers become meaningless when workflow changes
- Semantic names explain purpose without reading code
- Easier to find relevant tests when debugging

### Checklist

- [ ] Name test file semantically (what it verifies, not step number)
- [ ] Import `getTestBaseUrl()` from `tests/utils/test-config.ts`
- [ ] Use `const BASE_URL = getTestBaseUrl()` at module level
- [ ] Replace all URLs with `${BASE_URL}/path`
- [ ] NO hardcoded localhost:port ANYWHERE
- [ ] Add header comment about Docker default and TEST_BASE_URL override
- [ ] Verify test runs on Docker: `npm run test:e2e:docker` or `npm run test:integration`

### Example New Test

```typescript
/**
 * Feature X Integration Tests
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env.local)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { test, expect } from "@playwright/test";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("Feature X works", async ({ page }) => {
  await page.goto(`${BASE_URL}/feature-x`);
  // ... test logic
});
```

---

## Environment Variables

**.env.local file:**

```bash
DOCKER_PORT=3032  # Used by getTestBaseUrl() as default
```

**Per-worktree:**

```bash
# main/.env.local
DOCKER_PORT=3030

# dev/.env.local
DOCKER_PORT=3031

# dev2/.env.local
DOCKER_PORT=3032
```

**Test execution:**

```bash
# Uses DOCKER_PORT from current worktree .env.local
npm test

# Explicit override
TEST_BASE_URL=http://custom:8080 npm test
```

---

## CI/CD Integration

**GitHub Actions example:**

```yaml
- name: Build Docker
  run: npm run docker:restart

- name: Run E2E tests on Docker
  run: npm run test:e2e:docker
  # Uses DOCKER_PORT from .env.local automatically

- name: Run integration tests
  run: npm run test:integration
  # Uses DOCKER_PORT from .env.local automatically
```

**Production deployment tests:**

```yaml
- name: Test production
  run: TEST_BASE_URL=https://moira.example.com npm test
  # Runs all tests against deployed production
```

---

## MCP Inspector Tests

### Critical Importance

MCP Inspector tests (`tests/e2e/inspector-*.spec.ts`) verify the **primary use case** of the product.

MCP Moira is designed for AI agents as primary users (see [VISION.md](VISION.md)). Inspector tests validate:

- OAuth flow for MCP clients
- MCP tool execution through real protocol
- End-to-end agent workflow experience

These tests are **more important** than Web UI tests because they verify the core product functionality.

### Running Inspector Tests

**Prerequisite:** MCP Inspector service must be running on localhost:6274

```bash
# Start MCP Inspector
docker compose -f docker-compose.inspector.yml --env-file .env.inspector up -d

# Start MCP Moira Docker
npm run docker:restart

# Run Inspector tests
npm run test:e2e -- tests/e2e/inspector-*.spec.ts
```

### Test Files

| File                                   | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `inspector-oauth-flow.spec.ts`         | OAuth login flow via Inspector               |
| `inspector-oauth-login.spec.ts`        | Login with existing user                     |
| `inspector-oauth-registration.spec.ts` | Registration via OAuth flow                  |
| `inspector-mcp-tools.spec.ts`          | MCP tool execution (list, start, step, etc.) |

### Maintenance Priority

Inspector tests must be kept working. If changes break these tests:

1. Fix the tests immediately
2. Do not skip without explicit user approval
3. Document the issue if fix requires architectural changes

Skipping Inspector tests is equivalent to skipping tests for the core product functionality.
