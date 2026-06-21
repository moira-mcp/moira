# MCP E2E Testing Guide

E2E tests for MCP tools using pure HTTP OAuth flow without browser automation.

## Quick Start

```typescript
import { createAuthenticatedMCPClient, callMCPTool } from "../../utils/mcp-auth.js";

// Create authenticated MCP client
const { client, cleanup } = await createAuthenticatedMCPClient();

// Call MCP tool
const workflows = await callMCPTool(client, "list_workflows", {});

// Cleanup
await cleanup();
```

## Architecture

### OAuth Flow (4 HTTP Requests)

1. **Register OAuth Client**
   - POST `/api/auth/mcp/register`
   - Returns: `client_id`, `client_secret`

2. **Sign In User**
   - POST `/api/auth/sign-in/email`
   - Extract: `__Secure-better-auth.session_token` from Set-Cookie header

3. **Get Authorization Code**
   - GET `/api/auth/mcp/authorize?client_id=...`
   - Cookie: session token from step 2
   - Returns: 302 redirect with authorization `code`

4. **Exchange Code for Access Token**
   - POST `/api/auth/mcp/token`
   - Body: code, client_id, client_secret
   - Returns: `access_token`

5. **Connect MCP Client**
   - Create `Client` from `@modelcontextprotocol/sdk`
   - Use `StreamableHTTPClientTransport` with Bearer token
   - Call tools via `client.callTool()`

### Directory Structure

```
tests/
├── utils/
│   └── mcp-auth.ts              # OAuth utilities
├── fixtures/
│   ├── mcp-workflows.ts         # Workflow test fixtures
│   └── mcp-test-data.ts         # Test data constants
├── e2e/mcp-tools/
│   ├── README.md                # This file
│   ├── user-settings.test.ts    # Settings CRUD (5 tests)
│   ├── workflow-tokens.test.ts  # Token creation (6 tests)
│   ├── workflow-soft-delete.test.ts  # Delete/restore (4 tests)
│   ├── workflow-pagination.test.ts   # Pagination (4 tests)
│   ├── execution-context.test.ts     # Context tools (2 tests)
│   ├── workflow-execution.test.ts    # Execution flow (8 tests)
│   ├── workflow-crud.test.ts         # Create/edit (8 tests)
│   └── workflow-documentation.test.ts # Docs generation (14 tests)
└── config/
    └── jest.mcp-tools.config.js
```

## Test Utilities

### createAuthenticatedMCPClient()

Creates authenticated MCP client via OAuth flow.

**Usage:**

```typescript
// Default admin credentials
const { client, cleanup } = await createAuthenticatedMCPClient();

// Custom credentials
const { client, cleanup } = await createAuthenticatedMCPClient({
  email: "user@example.com",
  password: "userpass123",
});
```

**Returns:**

```typescript
{
  client: Client,              // MCP SDK Client
  transport: StreamableHTTPClientTransport,
  accessToken: string,         // Bearer token
  cleanup: () => Promise<void> // Close client
}
```

### callMCPTool()

Helper for calling MCP tools with automatic response parsing.

**Usage:**

```typescript
// Returns parsed JSON
const workflows = await callMCPTool(client, "list_workflows", {});

// Returns text for text-based tools
const deleteMsg = await callMCPTool<string>(client, "delete_workflow", {
  workflowId: "my-workflow",
});

// With arguments
const settings = await callMCPTool(client, "manage_settings", {
  action: "get",
  category: "ui",
});
```

**Response Handling:**

- Tries to parse as JSON
- Falls back to text if parsing fails
- Returns typed result based on generic parameter

### parseTokenResponse()

Parses formatted text responses from token creation tools.

**Usage:**

```typescript
const rawResult = await callMCPTool<string>(client, "create_workflow_token", {
  action: "download",
  workflowId: "my-workflow",
  ttlMinutes: 60,
});

const parsed = parseTokenResponse(rawResult);
// {token: '...', expiresAt: '...', downloadUrl: '...'}
```

## Writing Tests

### Test Template

```typescript
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("My MCP Tool Tests", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  test("tool_name returns expected data", async () => {
    const result = await callMCPTool(client, "tool_name", {
      param: "value",
    });

    expect(result).toHaveProperty("expectedField");
  });
});
```

### Using Fixtures

```typescript
import { MCP_TEST_WORKFLOWS } from "../../fixtures/mcp-workflows.js";
import { MCP_TEST_DATA } from "../../fixtures/mcp-test-data.js";

const { SIMPLE_LINEAR } = MCP_TEST_WORKFLOWS;
const { EXECUTION_INPUTS } = MCP_TEST_DATA;

test("execution test", async () => {
  // Use fixture workflow
  await callMCPTool(client, "create_workflow", {
    workflow: SIMPLE_LINEAR.workflow,
  });

  // Use test data constants
  await callMCPTool(client, "execute_step", {
    processId,
    input: EXECUTION_INPUTS.STEP1_SIMPLE,
  });
});
```

### Cleanup Pattern

```typescript
describe("Test Suite", () => {
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Create test workflows
    for (const wf of TEST_WORKFLOWS) {
      await callMCPTool(client, "create_workflow", { workflow: wf });
      createdWorkflows.push(wf.id);
    }
  });

  afterAll(async () => {
    // Delete all test workflows
    for (const workflowId of createdWorkflows) {
      try {
        await callMCPTool(client, "delete_workflow", { workflowId });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (cleanup) {
      await cleanup();
    }
  });
});
```

## MCP Tool Response Formats

### JSON Objects

```typescript
// create_workflow, edit_workflow
{success: true, workflowId: '...', validation: {valid: true}}

// list_workflows
[{id: '...', name: '...', visibility: '...', userId: '...'}]

// get_workflow_details
{success: true, metadata: {...}, nodes: [...], totalNodes: 10}

// get_execution_context
{executionId: '...', workflowId: '...', context: {variables: {...}}}

// get_user_settings
{'ui.theme': 'dark', 'telegram.bot_token': '...'}

// set_user_setting
{key: 'ui.theme', updated: true}
```

### Formatted Text

```typescript
// start_workflow, execute_step, get_current_step
"Process ID: abc-123\nYour next task: ...\nSuccess criteria: ...";

// delete_workflow, restore_workflow
"Workflow 'my-workflow' deleted successfully";

// list_deleted_workflows
"Deleted workflows (2):\n- workflow-1: Name - Description";

// create_workflow_upload_token, create_workflow_download_token
"Token: abc-123\nExpires: ...\nUpload URL: ...";
```

### Error Messages

```typescript
// Validation failures return error text
"Error: Workflow validation failed: /nodes: must NOT have fewer than 2 items";

// MCP protocol errors throw exceptions
try {
  await callMCPTool(client, "invalid_tool", {});
} catch (error) {
  // Handle MCP error
}
```

## Assertion Patterns

### Success Cases

```typescript
// JSON object response
expect(result).toHaveProperty("success", true);
expect(result).toHaveProperty("workflowId", expectedId);

// Array response
expect(Array.isArray(result)).toBe(true);
expect(result.length).toBeGreaterThan(0);

// Text response
expect(typeof result).toBe("string");
expect(result).toContain("successfully");

// Nested object
expect(result.context.variables).toHaveProperty("key", "value");
```

### Error Cases

```typescript
// Validation error (returns error text, not exception)
const result = await callMCPTool(client, "create_workflow", {
  workflow: INVALID_WORKFLOW,
});
expect(result.toLowerCase()).toMatch(/error|validation|invalid/);

// Exception from MCP protocol
try {
  await callMCPTool(client, "tool_name", INVALID_ARGS);
  expect(true).toBe(false); // Should not reach
} catch (error) {
  expect(error.message).toMatch(/expected pattern/);
}
```

### Database Side Effects

```typescript
// Verify data persisted
const result = await callMCPTool(client, "create_workflow", { workflow });
const workflows = await callMCPTool(client, "list_workflows", {});
const created = workflows.find((wf) => wf.id === workflow.id);
expect(created).toBeDefined();

// Verify data removed
await callMCPTool(client, "delete_workflow", { workflowId });
const afterDelete = await callMCPTool(client, "list_workflows", {});
expect(afterDelete.find((wf) => wf.id === workflowId)).toBeUndefined();
```

## HTTP Endpoint Testing (Supertest)

### File Upload

```typescript
import request from "supertest";
import { writeFileSync } from "fs";

const tempFile = "/tmp/test-workflow.json";
writeFileSync(tempFile, JSON.stringify(workflow));

const response = await request(BASE_URL)
  .post(`/api/public/workflows/upload/${token}`)
  .attach("workflow", tempFile)
  .expect(200);

expect(response.body).toHaveProperty("success", true);
```

### File Download

```typescript
const response = await request(BASE_URL).get(`/api/public/workflows/download/${token}`).expect(200);

const workflow = response.body;
expect(workflow).toHaveProperty("id");
expect(workflow).toHaveProperty("metadata");
expect(workflow).toHaveProperty("nodes");
```

## Test Requirements

### Isolation

- Each test must be independent
- Use `beforeAll` for shared setup (MCP client)
- Use `beforeEach` for per-test setup (test data)
- Clean up in `afterAll` (delete created workflows)

### Performance

- Default timeout: 10 seconds (Jest config)
- OAuth flow: ~200-500ms
- MCP tool call: ~10-50ms
- Use `timeout` parameter for long operations

### Error Handling

- Always check both success and error cases
- Verify error messages match expected patterns
- Test edge cases (empty input, invalid types, missing fields)

### Database Validation

- After create operations: verify data exists
- After delete operations: verify data removed
- After update operations: verify changes persisted
- Use separate tool calls for verification (not same call)

## Running Tests

```bash
# All MCP tests
npm run test:mcp-tools

# Specific test file
npm run test:mcp-tools -- tests/e2e/mcp-tools/user-settings.test.ts

# Specific test name
npm run test:mcp-tools -- --testNamePattern="list_setting_definitions"

# Watch mode (not recommended - use focused runs)
npm run test:mcp-tools -- --watch

# Full test suite (all tests)
npm test
```

## Debugging

### Enable Verbose Logging

Tests include OAuth flow logging by default:

```
[OAuth] Step 1: Registering client...
[OAuth] ✓ Client registered: abc123
[OAuth] Step 2: Signing in: admin@moira.local
[OAuth] ✓ Session cookie extracted
```

### Isolate Single Test

```bash
npm run test:mcp-tools -- --testNamePattern="exact test name"
```

### Check Server Logs

```bash
docker logs mcp-moira-dev2 | grep ERROR
docker exec mcp-moira-dev2 tail -100 /var/log/supervisor/mcp-server.log
```

### Common Issues

**401 Unauthorized:**

- Check Docker container running: `docker ps | grep mcp-moira`
- Verify base URL: `TEST_BASE_URL=http://localhost:${DOCKER_PORT}`
- Check admin user exists in database

**Timeout:**

- Increase Jest timeout in test file
- Check network connectivity to localhost:${DOCKER_PORT}
- Verify Docker container healthy

**Connection Refused:**

- Start Docker: `npm run docker:restart`
- Wait for healthy status: check logs

## Test Fixtures Reference

### Workflows (mcp-workflows.ts)

**SIMPLE_LINEAR** - 2-step linear flow

- Nodes: start → step1 → step2 → end
- Use for: Basic execution tests

**WITH_CONDITION** - Conditional branching

- Nodes: start → setup → condition → [path_true | path_false] → end
- Use for: Condition logic tests

**CONTEXT_PRESERVATION** - Context variables

- Tests: initialData from start + step input preservation
- Use for: Context/state tests

**MULTI_STEP** - 5 sequential steps

- Use for: Long execution, sequential flow tests

**VALIDATION_TEST** - Strict input schema

- Use for: Input validation tests

### Test Data (mcp-test-data.ts)

**EXECUTION_INPUTS:**

- `STEP1_SIMPLE`, `STEP2_SIMPLE` - Valid step inputs
- `CONDITION_TRUE`, `CONDITION_FALSE` - Condition test data
- `CONTEXT_DATA` - Context update data
- `VALID_INPUT`, `INVALID_MISSING_REQUIRED` - Validation test data

**TOKEN_DATA:**

- `TTL_SHORT`, `TTL_MEDIUM`, `TTL_LONG` - Token expiry durations
- `TEST_UPLOAD_WORKFLOW` - Minimal workflow for upload tests

**SETTINGS_DATA:**

- `UI_THEME_DARK`, `UI_THEME_LIGHT` - Theme settings
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` - Telegram config
- `PROFILE_DISPLAY_NAME` - Profile settings

**CRUD_WORKFLOWS:**

- `SIMPLE_CREATE` - Valid workflow for create tests
- `UPDATED_VERSION` - Updated metadata for overwrite tests
- `NEW_NODE` - Node for add/update/remove tests
- `INVALID_EMPTY_NODES`, `INVALID_NO_START` - Validation test cases

**DOCUMENTATION:**

- `TOPICS` - All documentation topics
- `NODE_TYPES` - Expected node types in docs
- `CORE_CONCEPTS` - Required concepts in documentation

## Best Practices

### DO

- Use fixtures for test data (DRY principle)
- Verify database side effects after mutations
- Test both success and error paths
- Use meaningful test descriptions
- Clean up created resources in afterAll
- Check if cleanup exists before calling

### DON'T

- Hardcode test data in test files
- Skip cleanup (causes test pollution)
- Assume error format (verify actual responses)
- Use browser automation for MCP protocol
- Test implementation details
- Duplicate existing test coverage

## Adding New MCP Tool Tests

1. **Create test file:** `tests/e2e/mcp-tools/my-new-tool.test.ts`

2. **Add fixture if needed:**
   - Workflow: add to `mcp-workflows.ts`
   - Test data: add to `mcp-test-data.ts`

3. **Write tests:**

   ```typescript
   test("my_new_tool returns expected data", async () => {
     const result = await callMCPTool(client, "my_new_tool", { arg: "value" });
     expect(result).toHaveProperty("expected");
   });
   ```

4. **Verify cleanup:**
   - Delete created resources in afterAll
   - Use try/catch to ignore cleanup errors

5. **Run tests:**

   ```bash
   npm run test:mcp-tools -- tests/e2e/mcp-tools/my-new-tool.test.ts
   ```

6. **Verify pass:**
   - All tests passing
   - No warnings in output
   - Cleanup successful

## Dependencies

- `@modelcontextprotocol/sdk` ^1.17.5 - Official MCP client
- `@jest/globals` ^30.1.2 - Test framework
- `supertest` ^7.1.4 - HTTP assertions
- `node-fetch` ^3.3.0 - OAuth HTTP requests

## Configuration

### Jest Config (`tests/config/jest.mcp-tools.config.js`)

```javascript
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/e2e/mcp-tools/**/*.test.ts"],
  maxWorkers: 1, // Sequential execution
};
```

### Environment

- `TEST_BASE_URL` - Base URL for tests (default: http://localhost:${DOCKER_PORT})
- `DOCKER_PORT` - Docker container port from .env.local

## Coverage Matrix

| MCP Tool                       | Tested    | Test File                      | Count  |
| ------------------------------ | --------- | ------------------------------ | ------ |
| create_workflow                | ✅        | workflow-crud.test.ts          | 3      |
| edit_workflow                  | ✅        | workflow-crud.test.ts          | 5      |
| delete_workflow                | ✅        | workflow-soft-delete.test.ts   | 2      |
| restore_workflow               | ✅        | workflow-soft-delete.test.ts   | 2      |
| list_deleted_workflows         | ✅        | workflow-soft-delete.test.ts   | 2      |
| list_workflows                 | ✅        | Multiple                       | 8      |
| get_workflow_details           | ✅        | workflow-pagination.test.ts    | 4      |
| start_workflow                 | ✅        | workflow-execution.test.ts     | 4      |
| execute_step                   | ✅        | workflow-execution.test.ts     | 5      |
| get_current_step               | ✅        | workflow-execution.test.ts     | 2      |
| get_execution_context          | ✅        | execution-context.test.ts      | 1      |
| update_execution_context       | ✅        | execution-context.test.ts      | 1      |
| get_workflow_documentation     | ✅        | workflow-documentation.test.ts | 14     |
| create_workflow_upload_token   | ✅        | workflow-tokens.test.ts        | 1      |
| create_workflow_download_token | ✅        | workflow-tokens.test.ts        | 1      |
| list_setting_definitions       | ✅        | user-settings.test.ts          | 1      |
| get_user_settings              | ✅        | user-settings.test.ts          | 2      |
| set_user_setting               | ✅        | user-settings.test.ts          | 1      |
| delete_user_setting            | ✅        | user-settings.test.ts          | 1      |
| **Total**                      | **19/19** | **8 files**                    | **52** |

## HTTP Endpoints Tested

| Endpoint                              | Method | Test File               | Count |
| ------------------------------------- | ------ | ----------------------- | ----- |
| /api/public/workflows/upload/:token   | POST   | workflow-tokens.test.ts | 2     |
| /api/public/workflows/download/:token | GET    | workflow-tokens.test.ts | 2     |

## Common Patterns

### Process ID Extraction

```typescript
const startResult = await callMCPTool<string>(client, "start_workflow", {
  workflowId: "my-workflow",
});

const processId = startResult.match(/Process ID: ([a-f0-9-]+)/)![1];
```

### Sequential Execution

```typescript
for (let i = 1; i <= 5; i++) {
  const currentStep = await callMCPTool<string>(client, "get_current_step", {
    processId,
  });

  expect(currentStep).toContain(`Complete step ${i}`);

  await callMCPTool(client, "execute_step", {
    processId,
    input: { result: `Step ${i} done` },
  });
}
```

### Workflow Lifecycle

```typescript
// Create
await callMCPTool(client, "create_workflow", { workflow });

// Use
const startResult = await callMCPTool(client, "start_workflow", { workflowId });

// Delete
await callMCPTool(client, "delete_workflow", { workflowId });

// Restore
await callMCPTool(client, "restore_workflow", { workflowId });
```

## Troubleshooting

### Test Fails with "cleanup is not a function"

**Cause:** OAuth flow failed in beforeAll, cleanup not set
**Fix:** Add null check in afterAll:

```typescript
afterAll(async () => {
  if (cleanup) {
    await cleanup();
  }
});
```

### Test Fails with "FOREIGN KEY constraint failed"

**Cause:** Using non-existent userId
**Fix:** Use `system-admin` (exists after migrations):

```typescript
const testUserId = "system-admin";
```

### Response Format Mismatch

**Cause:** Expecting JSON but tool returns text
**Fix:** Check actual response format, use appropriate type:

```typescript
const result = await callMCPTool<string>(client, "tool_name", {});
expect(typeof result).toBe("string");
```

### Process Already Completed

**Cause:** Trying to execute_step on finished execution
**Fix:** Check execution status before calling:

```typescript
const context = await callMCPTool(client, "get_execution_context", { executionId });
if (context.status === "completed") {
  // Handle completed state
}
```
