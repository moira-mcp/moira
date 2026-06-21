---
title: Troubleshooting
description: Common issues and solutions for AI agents working with MCP Moira
sidebar:
  order: 4
---

This guide helps recover from common issues when working with MCP Moira workflows.

## Context Recovery After Session Archive

When a conversation is archived or compacted, the agent loses:

- Current execution ID (processId)
- Workflow step context
- Progress information

The workflow state persists on the MCP server - only the agent's memory is lost.

### Recovery Steps

1. **Find active executions:**

```json
session({ action: "executions" })
```

Returns list of executions with status, workflow ID, and notes:

```json
[
  {
    "executionId": "abc-123",
    "workflowId": "development-flow",
    "status": "waiting",
    "note": "Feature: auth system",
    "currentNodeId": "implement-step"
  }
]
```

2. **Get current step without advancing:**

```json
session({ action: "current_step", executionId: "abc-123" })
```

Returns the current directive and context:

```json
{
  "directive": "Implement the feature...",
  "completionCondition": "Feature working and tested",
  "inputSchema": { ... }
}
```

3. **Continue workflow:**

```json
step({ processId: "abc-123", input: { ... } })
```

### Process ID Preservation

To help future recovery, save the process ID in your workspace:

```bash
# Create process-id.txt in feature directory
echo "abc-123" > ./feature-name/process-id.txt
```

Include in session archives:

- Feature name
- Process ID
- Current step description

## Navigation Tools Reference

### session - executions

Lists all active workflow executions for current user.

**Call:** `session({ action: "executions" })`

**Filters:**

- `status`: Array of statuses - `["waiting", "running", "completed", "failed"]`
- `workflowId`: Filter by specific workflow
- `search`: Search in execution notes

**Example with filters:**

```json
session({
  action: "executions",
  status: ["waiting", "running"],
  search: "auth"
})
```

### session - current_step

Retrieves current step directive without advancing the workflow.

**Call:** `session({ action: "current_step", executionId: "..." })`

**Parameters:**

- `executionId` (required): Execution ID to check

**Returns:**

- `directive`: What to do
- `completionCondition`: Success criteria
- `inputSchema`: Response structure

### session - execution_context

Gets full execution state including context variables.

**Call:** `session({ action: "execution_context", executionId: "..." })`

**Parameters:**

- `executionId` (required): Execution ID to inspect

**Returns:**

- `executionId`: Execution UUID
- `workflowId`: Workflow being executed
- `status`: Execution status (running, waiting, completed, failed)
- `currentNodeId`: Current node ID
- `waitingForInputNodeId`: Node waiting for input (if any)
- `note`: Execution note
- `context.variables`: Context variables
- `context.nodeStates`: Node execution states
- `createdAt`, `updatedAt`, `completedAt`: Timestamps
- `error`: Error message (if failed)

## Common Issues

### "Process not found or expired"

**Cause:** Invalid or expired processId

**Solution:**

1. Use `session({ action: "executions" })` to find active executions
2. Use the correct executionId from the list
3. Process IDs are UUIDs like `abc123-def456-...`

### "Execution is not waiting for input"

**Cause:** Trying to advance a completed or failed execution

**Solution:**

1. Check execution status with `session({ action: "execution_context", executionId: "..." })`
2. Status must be `waiting` to accept input
3. If `completed` or `failed`, start a new execution

### Validation Errors on step()

**Cause:** Input doesn't match inputSchema

**Solution:**

1. Check `inputSchema` from current step
2. Verify field names match exactly (case sensitive)
3. Verify data types match (string vs number)
4. Include all required fields

### Agent Forgets Workflow Context

**Cause:** Session was archived/compacted

**Solution:**

1. Check for process-id.txt in workspace
2. Use `session({ action: "current_step" })` to get context
3. Remind agent: "Continue workflow \{processId\}"

### Seeing `[[UNDEFINED_VARIABLE]]` in a directive at runtime

**Cause:** A referenced variable was unresolved when the directive was rendered. Three causes:

1. The variable is not declared in `variableRegistry`.
2. The variable is declared but has no `default` and was not yet written by an upstream node before the directive used it.
3. A bare `{{...}}` was placed into data the agent returned via `step()`, and that data was later interpolated into a directive (template-in-data). Returned data values are literal — they are not re-scanned as templates.

The engine logs a warning naming the residual placeholder and the `executionId`.

**Solution:**

1. Declare the variable in `variableRegistry` with a `default`.
2. Ensure an upstream node writes the variable (via `globalInputs`) before its first use.
3. Never echo `{{...}}` into data you return from `step()` — keep templates only in static node fields.

## Recovery Scenarios

### Scenario: Resume After Interruption

```
User: Continue working on the auth feature

Agent:
1. session({ action: "executions", search: "auth" })
   → Found: executionId: "abc-123", status: "waiting"

2. session({ action: "current_step", executionId: "abc-123" })
   → directive: "Implement login endpoint"

3. [Does the work]

4. step({ processId: "abc-123", input: { result: "done" } })
```

### Scenario: Find Lost Process ID

```
User: What workflows am I running?

Agent:
1. session({ action: "executions" })
   → Lists all active executions with notes

2. session({ action: "execution_context", executionId: "abc-123" })
   → Shows full context including variables
```

### Scenario: Check Why Workflow Stuck

```
Agent:
1. session({ action: "execution_context", executionId: "abc-123" })
   → status: "waiting", currentNodeId: "validation-step"

2. session({ action: "current_step", executionId: "abc-123" })
   → Shows what the workflow is waiting for
```

## Related Documentation

- [MCP Agent Guide](/docs/docs/integration/agent-guide) - Tool usage basics
- [MCP Tools Reference](/docs/docs/reference/tools) - Full tool documentation
