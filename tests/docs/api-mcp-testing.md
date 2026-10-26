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

## Test recipients and delivery

Use unique test-owned accounts rather than the configured administrator or another person's email.
Recipient naming suppresses real delivery only when the **selected backend deployment** sets
`EMAIL_TEST_RECIPIENTS=true`. Setting that variable on a browser-test command does not reconfigure
an already running server. With `EMAIL_PROVIDER=test`, every message is logged without sending;
with a real SMTP/Brevo provider and explicit recipient suppression, only recognized test addresses
are redirected to the log-only sink. Other recipients still use the real provider.

The [email owner](../../packages/shared/src/email/index.ts) recognizes addresses at `example.com`,
the retained fixture domain `test.com`, `test.local`, `moira.local`,
`load-testing-noverify.local`, and subdomains ending in `.test`. Prefer unique addresses such as
`e2e-reset-<unique-id>@example.com`, and inspect the current source before adding a recipient pattern.
Reuse the maintained signup/session helpers above for account preparation.

Assert the observed delivery result: `delivery: logged` and the corresponding durable email log
establish log-only handling, not a sent message. A deployment can retain real-provider capability
while a particular test recipient is suppressed. Do not run mail-producing tests against an
uncontrolled deployment or infer suppression from the email address alone.

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

test("workflow list returns workflows", async () => {
  const result = await callMCPTool<{ workflows: unknown[] }>(client, "workflow", {
    action: "list",
  });
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

Discover the current typed catalog through `client.listTools()`. Each grouped tool action has its
own strict input schema; use `workflow` for definition/list/import/export operations and
`execution` for start, step and run inspection. Pass structured values in their declared types.
For native-file actions preserve the host descriptor and metadata in the declared top-level
`file` or `stdin_file` field unchanged; that field is required only by the action that consumes it.
A catalog revision refusal requires
reinitialization with the same valid credential, not an old tool alias or a replacement token.

## Account admission and retirement

Test the actual protected route and registered MCP transport, rather than accepting an unknown
endpoint's 404 as evidence that authorization worked. Establish that each owned credential works
before changing the account, then observe its refusal afterward. [Shared account admission](../../packages/shared/src/auth/account-admission.ts),
[HTTP middleware](../../packages/web-backend/src/middleware/auth-middleware.ts) and the
[MCP server](../../packages/mcp-server/src/server.ts) enforce distinct stages:

- A pending self-host account can read `/api/user/me` and sign out, while product/token/OAuth/MCP
  access returns `ACCOUNT_APPROVAL_REQUIRED`. Approval and email verification are independent.
- SaaS sensitive admission applies its email-verification gate. Do not infer universal verification
  from an ordinary route that intentionally requires only session admission.
- Blocking refuses new sign-in and use of existing credentials. Exercise browser session, OAuth
  issuance/refresh or access, and persistent-token use when those are the changed boundary; a
  successful session-revocation test alone proves none of the other paths.
- Assert the expected status/code at the actual stage. Invalid/revoked credentials can fail before
  account lookup, whereas a still-valid persistent credential reaches the blocked-account gate.
  Blocking need not delete every API-token row to refuse that credential.
- The block route can return `503 SCOPED_CREDENTIAL_DISPOSAL_PENDING` after the block is committed.
  Verify blocked state and retained custody rather than treating it as rollback. Account deletion
  has a separate pending-resource/credential `409` contract; refusal is not completed erasure.

Use a non-admin credential for direct administrator API refusal, and inspect unchanged owned state
when an unauthorized mutation is attempted. Deployment capability refusal and resource owner-use
authority are separate from administrator role. Reuse [HTTP contracts](../../docs/reference/http-api.md)
and [account operations](../../docs/operator/accounts.md), not a universal 401/403 rule for every
endpoint.

## Real MCP client acceptance

The SDK helper proves its own registration, authorization and transport flow. Compatibility with
an installed client requires explicitly authorized use of that actual client, current configuration,
browser login/consent and a harmless tool call whose full result is inspected. A client reconnect
must satisfy current catalog initialization and account admission; neither a visible tool list nor
a stale cached result proves a request succeeded. Use the maintained client setup documentation
instead of copying installation-specific configuration paths into this guide. Record the tested
client and unresolved prerequisites without promoting a simulated or skipped provider flow to a
pass. Native attachments additionally require exact bytes/metadata and their owner/lifetime
boundary; text-only SDK results do not establish native delivery.

## Workflow execution

Reuse `startWorkflowExecutionState(client, workflowId, options)` for public `execution` prepare/execute start.
It returns process ID, current Step attempt ID and response. Use
`advanceWorkflowExecution(client, execution, input)` to submit the current attempt and retain any
successor attempt identity in that execution object. Supply the actual workflow schema's input.
For intentional parent linkage, pass the parent option explicitly.

Do not extract only a process ID and omit the required Step attempt. Replay, conflicting attempts,
unknown outcomes and stale-presentation recovery need their own explicit assertions at the public
boundary. A deliberate new start is a separate intention; collecting an uncertain original is not
permission to resubmit an effect.

Use `execution` with `current_step` for the current presentation. An incompatible saved definition
needs explicit `diagnose` and authorized `recover` on the same execution, not a fresh start or an
unconditional rebind. Complete earlier-definition cases in
[catalog task identity](../integration/catalog-task-identity.test.ts) retain captured originals,
task state and guide files while verifying compatible continuation or guarded recovery.

```bash
npm run test:api -- --file tests/api/workflow-update.test.ts
npm run test:mcp-tools -- --file tests/mcp-tools/workflow-execution.test.ts
```

Keep test-owned workflows, users, streams and clients in cleanup, including when setup only
partially succeeds. Existing [workflow fixtures](../fixtures/mcp-workflows.ts) and
[test data](../fixtures/mcp-test-data.ts) can supply inputs; inspect their current schema rather than
copying a fixture catalogue into a guide. HTTP publication/upload tests verify actual bytes,
authorization and lifetime separately from a tool's text response.
