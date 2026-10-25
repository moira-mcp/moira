### Custom Client

For custom MCP client implementations, use the MCP SDK with URL: `{MCP_URL}`

## Available Tools

The core lifecycle is `list` → `start` prepare → `start` execute → repeated `step` calls, with `session` for inspecting or
resuming executions and `help` for runtime documentation. The
[MCP tools reference](/docs/reference/tools/) is the source for the complete current
catalog, exact input schemas, actions, and examples.

## Authentication

Moira supports two authentication methods:

### OAuth 2.1 (Default)

1. Client connects to the MCP endpoint.
2. Server requests authentication.
3. Client opens the OAuth flow in a browser.
4. User authenticates with Moira.
5. Client receives an access token.
6. Subsequent requests include that token.

:::note
OAuth token refresh is handled automatically and preserves the catalog state accepted by the
previous access token. Catalog refresh after a server contract change is a separate MCP
initialization step described below. If the credential expires, re-authentication may be required.
:::

### API Tokens

For MCP clients that do not support OAuth (custom scripts, CI/CD pipelines, headless environments), use API tokens:

1. Log in to Moira web UI.
2. Open **Settings → Apps & tokens → API tokens**.
3. Choose **Create Token**, then enter its name and expiration.
4. Copy the token, shown once and starting with `moira_`.
5. Configure the client with Bearer authorization; keep the token out of committed files and logs.

Use the selected client's token example above. JSON, YAML and TOML clients store authorization
differently; do not copy another client's format. For a custom SDK client, configure
`Authorization: Bearer moira_...` on its HTTP transport to `{MCP_URL}`.

:::tip
API tokens skip the OAuth flow entirely. Use the configured endpoint `{MCP_URL}` and preserve
other server entries when merging a token alternative. An already working connection needs no
new token or login.
:::

## Static Catalog Refresh

Tool descriptions and schemas are a static catalog shipped with the Moira server. A client accepts
that catalog during the MCP `initialize` handshake. This applies to both OAuth access tokens and API
tokens.

When the catalog changes, an ordinary request made with a credential that has not initialized the
current catalog returns HTTP 426 with `upgrade_required`. Reconnect or reinitialize the MCP server
with the same credential. A successful initialize refreshes the catalog for that credential; it
does not require a new API token. OAuth access tokens may rotate independently during automatic
refresh without losing their current, stale, or uninitialized catalog state.

:::note
Authentication and account checks run before catalog refresh. A revoked or expired credential, or
an account that cannot access MCP, still receives its normal authentication or access error.
:::

## Tool Call Examples

### List Workflows

```json
{
  "method": "tools/call",
  "params": {
    "name": "list",
    "arguments": {}
  }
}
```

### Prepare Workflow Start

```json
{
  "method": "tools/call",
  "params": {
    "name": "start",
    "arguments": {
      "action": "prepare",
      "workflowId": "moira/software-development-flow",
      "parentExecutionId": "none"
    }
  }
}
```

Preparation returns a `startAttemptId` without creating an execution. Execute it in a second call:

```json
{
  "method": "tools/call",
  "params": {
    "name": "start",
    "arguments": {
      "action": "execute",
      "startAttemptId": "start-attempt-current"
    }
  }
}
```

### Execute Step

```json
{
  "method": "tools/call",
  "params": {
    "name": "step",
    "arguments": {
      "processId": "abc-123",
      "attemptId": "attempt-current",
      "input": {
        "result": "Task completed successfully",
        "details": { "files": ["main.ts", "utils.ts"] }
      }
    }
  }
}
```

## Error Handling

Common error responses:

| Error                               | Cause                             | Solution                                                |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `UNAUTHORIZED`                      | Invalid/expired token             | Re-authenticate                                         |
| `NOT_FOUND`                         | Invalid workflow/process ID       | Verify IDs                                              |
| `FORBIDDEN`                         | No access to resource             | Check permissions                                       |
| `upgrade_required`                  | MCP catalog must be refreshed     | Reconnect using the same credential                     |
| `VALIDATION_ERROR`                  | Invalid input                     | Check input schema                                      |
| `ATTEMPT_PROCESSING`                | Duplicate still executing         | Retry the same attempt and input                        |
| `ATTEMPT_STALE`                     | Presentation is no longer current | Read `current_step`; reconcile intent before submission |
| `ATTEMPT_CONFLICT`                  | Attempt is bound to other input   | Read `current_step`; discard old input                  |
| `ATTEMPT_INVALID_OR_EXPIRED` (step) | Attempt is unavailable            | Read `current_step`; discard attempt                    |
| `ATTEMPT_OUTCOME_UNKNOWN`           | Effect may have occurred          | Inspect the returned Process ID                         |

## Self-Hosted Setup

For full recovery distinctions, see [Troubleshooting](/docs/integration/troubleshooting/). A fresh presentation never authorizes carrying an old answer into another step; an unknown outcome is collected, not automatically replayed.

For self-hosted Moira:

1. Deploy Moira server
2. Configure MCP endpoint URL
3. Set up authentication and account access
4. Update client configuration with your endpoint

## Troubleshooting

### Connection Timeout

- Check network connectivity
- Verify endpoint URL
- Ensure SSE is not blocked by firewall

### Tools Not Appearing

- Reconnect the Moira MCP server so the client runs `initialize` again
- Keep the existing OAuth or API-token credential unless it is invalid or expired
- Check the selected client's configuration format and diagnostics in its official guide above
- Check client logs for errors

### Authentication Loop

- Check the selected server URL, account and client status before changing credentials
- Distinguish authentication refusal from HTTP 426: the latter requires initialization with the same credential
- Inspect client diagnostics and the official OAuth instructions, including redirect requirements
- Reauthenticate only when the existing credential is invalid or expired and refresh cannot recover it; do not clear unrelated connections

## Related

- [Claude Code](/docs/integration/claude-code/) - Claude Code specific setup
- [Quick Start](/docs/getting-started/quickstart/) - General getting started
