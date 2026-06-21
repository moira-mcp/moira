# API & MCP Testing Guide

## MCP Tools Tests

**Location:** `tests/mcp-tools/`
**Database:** `./data/moira.db` (Docker)

```bash
npm run test:mcp-tools              # Local Docker
npm run test:mcp-tools:remote       # Remote server
```

**Requires:** Docker for local, credentials for the remote target

---

## Why MCP Tests Are Critical

**ALL MCP functionality MUST be tested through MCP tests.**

MCP is the primary way users interact with the system. Any new MCP-related functionality MUST be covered by E2E MCP tests.

### What MUST Be Tested Through MCP

- New MCP tools
- New actions in existing tools (e.g., `manage({ action: "new-action" })`)
- New tool parameters (e.g., `parentExecutionId` in start)
- New node handlers (expression, condition, etc.) — via workflow execution
- Handler behavior changes — via workflow execution
- Magic variables (e.g., `execution_note`)
- Template processing in directives
- Condition evaluation
- Any changes affecting workflow execution

### Why Unit/Integration Tests Are NOT Enough

- MCP tool registration in `server.ts` has separate schema from implementation
- Integration tests call executor/services directly, bypassing MCP layer
- Schema mismatches between `server.ts` and tool code are NOT caught by integration tests
- Real users work through MCP protocol, not direct code calls

### Example Bug NOT Caught by Integration Tests

```typescript
// server.ts - MCP registration (WRONG schema)
action: z.enum(["user", "executions", "execution_context", "current_step"]);

// get-session-info.ts - actual tool (CORRECT schema)
action: z.enum(["user", "executions", "execution_context", "current_step", "update-note"]);

// Integration test (PASSES - bypasses MCP)
await executor.updateNote(executionId, "new note"); // Works!

// Real MCP call (FAILS - schema mismatch)
session({ action: "update-note" }); // Error: Invalid enum value
```

---

## Authenticated MCP Client

MCP tools require an authenticated session. Create a client with
`createAuthenticatedMCPClient()`, then call tools with `callMCPTool(client, name, args)`:

```typescript
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const mcpClient = await createAuthenticatedMCPClient();
  client = mcpClient.client;
  cleanup = mcpClient.cleanup;
});

afterAll(async () => {
  await cleanup();
});

const result = await callMCPTool<{ workflows: unknown[] }>(client, "list", {});
expect(result.workflows).toBeDefined();
```

### How the helpers work

1. `createAuthenticatedMCPClient()` signs in with admin credentials and returns a
   connected `Client` plus a `cleanup` function.
2. `callMCPTool(client, toolName, args)` calls the tool over the MCP transport,
   extracts the text content, and JSON-parses it (falling back to the raw text if
   it is not JSON).
3. `callMCPToolRaw()` returns the raw text response (used for output-format checks).

---

## Testing New Node Handlers

```typescript
test("expression node executes through MCP workflow", async () => {
  // 1. Start workflow with expression node via MCP
  const startResult = await callMCPTool(client, "start", {
    workflowId: "test-expression",
    parentExecutionId: "none",
  });

  // 2. Execute step via MCP
  const stepResult = await callMCPTool(client, "step", {
    processId: startResult.processId,
    input: {},
  });

  // 3. Verify expression evaluated and context updated
  expect(stepResult.directive).toContain("counter is now 1");
});
```

---

## API Tests

**Location:** `tests/api/`
**Database:** `./data/moira.db` (Docker)

```bash
npm run test:api              # Local Docker
npm run test:api:remote       # Remote server
```

### Standards

- Real HTTP requests
- Test auth/authorization
- Verify status codes
- Test error responses

### Example API Test

```typescript
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("Workflow API", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getAdminCredentials()),
    });
    sessionCookie = loginRes.headers.get("set-cookie") || "";
  });

  test("GET /api/workflows returns list", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.workflows)).toBe(true);
  });

  test("POST /api/workflows requires auth", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });

    expect(response.status).toBe(401);
  });
});
```

---

### Environment Helpers

```typescript
import { getTestEnvironment, isExternalTarget } from "../utils/test-config.js";

// Check environment
if (isExternalTarget()) {
  // Skip destructive tests on a remote target
}

const env = getTestEnvironment(); // "local" | "production"
```
