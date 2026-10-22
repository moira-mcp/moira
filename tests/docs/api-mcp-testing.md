# API and MCP testing

Use [API suites](../api/) for deployed HTTP behavior and [MCP suites](../mcp-tools/) for registered
tool schemas, SDK transport, admission and public responses. Lower-level engine tests own algorithm
edge cases; protocol tests add value when they observe a different boundary. Start with the
[testing guide](../TESTING-GUIDE.md) and select the target through
[infrastructure configuration](test-infrastructure.md#target-selection).

## HTTP preparation

[mcp-auth.ts](../utils/mcp-auth.ts) provides HTTP account/session preparation as well as the SDK
client. Reuse its actual signatures:

| Helper                                                               | Result or responsibility                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `createTestUserViaApi(baseUrl, email, password, name, verifyEmail?)` | Signup with consent, actual user identity, optional email verification and deployment-specific approval; returns `{ userId }`. |
| `verifyUserEmail(baseUrl, email)`                                    | Admin-authorized email verification. It does not replace deployment account approval.                                          |
| `blockUserViaApi(baseUrl, userId, reason?)`                          | Signs in as the configured admin and blocks the selected user. The third argument is a reason, not a cookie.                   |
| `signInUser(baseUrl, email, password)`                               | Session cookie value.                                                                                                          |
| `getAdminSessionCookie(baseUrl)`                                     | Fresh configured-admin signin; returns the value.                                                                              |
| `formatSessionCookie(baseUrl, value)`                                | Ready Cookie header with the protocol-appropriate cookie name.                                                                 |

For an API test directly under `tests/api/`:

```typescript
import { beforeAll, expect, test } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import { getAdminSessionCookie, formatSessionCookie } from "../utils/mcp-auth.js";

const baseUrl = getTestBaseUrl();
let cookie: string;
beforeAll(async () => {
  cookie = formatSessionCookie(baseUrl, await getAdminSessionCookie(baseUrl));
});

test("an administrator reads workflows", async () => {
  const response = await fetch(`${baseUrl}/api/workflows`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.workflows)).toBe(true);
});
```

Use owned records and dedicated accounts for destructive cases. Assert authorization refusal and
unchanged persisted state where those are the contract. Direct Better Auth requests also need the
configured public Origin; the API setup and shared signin helpers supply that boundary. Do not
hard-code credentials or print environment values. Remote Node preparation can require
`getTestFetchUrl()` rather than the browser URL; see the target resolver before adapting an example.

## Authenticated SDK client

For a file directly under `tests/mcp-tools/`:

```typescript
import { afterAll, beforeAll, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";

let client: Client;
let cleanup: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const authenticated = await createAuthenticatedMCPClient();
  client = authenticated.client;
  cleanup = authenticated.cleanup;
});
afterAll(async () => {
  await cleanup?.();
});

test("list returns workflows", async () => {
  const result = await callMCPTool<{ workflows: unknown[] }>(client, "list", {});
  expect(Array.isArray(result.workflows)).toBe(true);
});
```

The helper performs OAuth client registration, user signin, authorization-code exchange and an SDK
connection using the Node fetch target. Cleanup closes the SDK client. Custom account credentials
can be supplied; prepare its admission separately where required.

`callMCPTool` parses the first text block as JSON, falling back to text. `callMCPToolRaw` returns
that text. Neither is a substitute for inspecting the complete SDK result when asserting `isError`,
native image content or block identity. Use `client.callTool` for those contracts and assert the
actual error/result shape; do not assume all application refusals throw exceptions.

## Workflow execution

Reuse `startWorkflowExecutionState(client, workflowId, options)` for public prepare/execute start.
It returns process ID, current Step attempt ID and response. Use
`advanceWorkflowExecution(client, execution, input)` to submit the current attempt and retain any
successor attempt identity in that execution object. Supply the actual workflow schema's input.
For intentional parent linkage, pass the parent option explicitly.

Do not extract only a process ID and omit the required Step attempt. Replay, conflicting attempts,
unknown outcomes and stale-presentation recovery need their own explicit assertions at the public
boundary. A deliberate new start is a separate intention; collecting an uncertain original is not
permission to resubmit an effect.

```bash
npm run test:api -- --file tests/api/workflow-update.test.ts
npm run test:mcp-tools -- --file tests/mcp-tools/workflow-execution.test.ts
```

Keep test-owned workflows, users, streams and clients in cleanup, including when setup only
partially succeeds. Existing [workflow fixtures](../fixtures/mcp-workflows.ts) and
[test data](../fixtures/mcp-test-data.ts) can supply inputs; inspect their current schema rather than
copying a fixture catalogue into a guide. HTTP publication/upload tests verify actual bytes,
authorization and lifetime separately from a tool's text response.
