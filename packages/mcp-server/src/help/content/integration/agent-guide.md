---
title: MCP Agent Guide
description: How to use MCP Moira tools and execute workflows
sidebar:
  order: 2
---

This guide explains how AI agents use MCP Moira tools to execute workflows.

## MCP Tools Overview

MCP Moira exposes these tools:

| Tool            | Purpose                       |
| --------------- | ----------------------------- |
| `list`          | List available workflows      |
| `start`         | Prepare or execute a start    |
| `step`          | Advance workflow with input   |
| `manage`        | CRUD operations on workflows  |
| `session`       | User info and execution state |
| `settings`      | User settings                 |
| `communication` | Authenticated user delivery   |
| `token`         | Upload/download tokens        |
| `help`          | Documentation                 |

## Basic Workflow Execution

### 1. Prepare and Start Workflow

```json
start({ action: "prepare", workflowId: "moira/robust-task", parentExecutionId: "none" })
```

Preparation validates the request and reserves a Start attempt for 15 minutes without creating an
execution or running any workflow node. It returns `startAttemptId` independently of mutable
notification and trusted-lock readiness. Execute that exact attempt to run those preflight checks:

```json
start({ action: "execute", startAttemptId: "start-attempt-123" })
```

The successful execution response contains:

```json
{
  "processId": "abc-123-def",
  "attemptId": "attempt-456",
  "directive": "Break down the task into steps...",
  "completionCondition": "Task breakdown complete with 3+ steps",
  "inputSchema": {
    "type": "object",
    "properties": {
      "steps": { "type": "array" }
    },
    "required": ["steps"]
  }
}
```

During `execute`, a generic notification workflow with no configured user channel returns a stable
`START_PRECONDITION_CHANGED` receipt containing Settings > Notifications guidance and creates no
execution. Legacy Telegram-notification workflows return Telegram setup guidance. Set
`skipNotificationCheck: true` during prepare only to bypass optional ordinary-notification preflight
at execute; it never authorizes a send or bypasses mandatory Telegram configuration for a `lock`
node.

Repeat `execute` with the same Start attempt ID when its response is lost: a completed attempt
returns the exact stored response and cannot create a second execution. Preparing again is an
intentional request for a separate execution.

### 2. Execute Step

After completing the work described in `directive`:

```json
step({
  processId: "abc-123-def",
  attemptId: "attempt-456",
  input: {
    "steps": ["Step 1", "Step 2", "Step 3"]
  }
})
```

Returns next directive or completion status.

### 3. Continue Until Complete

Repeat `step()` calls until workflow returns completion.

Use the Step attempt ID from the current presentation for every call, including a step with empty
input. A replay of the same attempt with the same input returns its stored result without advancing
again. Never use an attempt from an older presentation.

## Response Format

Every workflow step returns:

| Field                 | Description                                        |
| --------------------- | -------------------------------------------------- |
| `processId`           | UUID for this execution, use in all `step()` calls |
| `attemptId`           | Identity of this exact presented step              |
| `directive`           | What to do (the instruction)                       |
| `completionCondition` | When you're done (success criteria)                |
| `inputSchema`         | How to structure your response (JSON Schema)       |

## Understanding Directives vs Conditions

**directive** = WHAT to do
**completionCondition** = WHEN you're successfully done

Example:

- directive: "Run all project tests"
- completionCondition: "All tests pass (0 failures)"

The agent must:

1. Execute the directive (run tests)
2. Verify the completionCondition is met (check for 0 failures)
3. Only then proceed with `step()`

## Input Schema

When `inputSchema` is provided, your response must match the schema exactly.

Example schema:

```json
{
  "type": "object",
  "properties": {
    "result": {
      "type": "string",
      "enum": ["pass", "fail"]
    },
    "evidence": {
      "type": "string"
    }
  },
  "required": ["result", "evidence"]
}
```

Valid response:

```json
{
  "result": "pass",
  "evidence": "All 302 tests passed"
}
```

Submit a single flat object containing exactly the properties in `inputSchema` — one object per step, with every `required` property present. Keys not described in the schema are rejected. Some of a step's values are workflow-wide and some are local to the step, but the schema you receive already merges both into one ordinary object: you do not declare or distinguish them — just match the schema.

## Navigation Tools

### List Executions

```json
session({ action: "executions" })
```

Returns the first page of active executions for the current user with status, workflow ID, and
notes. Use `limit` and `offset` for additional pages.

### Get Current Step

Resume workflow after interruption:

```json
session({ action: "current_step", executionId: "abc-123" })
```

Returns the current agent-facing step presentation without advancing the workflow, including the
Process ID, Step attempt ID, directive, success criteria, and input schema when present. Applicable child-workflow,
system-reminder, and teleport context is included as well.

### Get Full Context

```json
session({ action: "execution_context", executionId: "abc-123" })
```

Returns execution state including context variables and history.

## Execution Notes

Track execution progress with notes:

```json
start({ action: "prepare", workflowId: "dev-flow", note: "Feature: auth system", parentExecutionId: "none" })
start({ action: "execute", startAttemptId: "start-attempt-123" })
```

Update note during execution via `step()` input:

```json
step({
  processId: "abc-123",
  attemptId: "attempt-456",
  input: {
    "task_result": "done",
    "execution_note": "Step 3: Integration tests"
  }
})
```

Or via session tool:

```json
session({
  action: "update-note",
  executionId: "abc-123",
  note: "Step 3: Integration tests"
})
```

## Finding Workflows

### List the First Page

```json
list()
```

### Search by Name

```json
list({ search: "test" })
```

### Filter by Visibility

```json
list({ visibility: "public", limit: 10 })
```

## Common Patterns

### Start and Execute First Step

```json
// 1. Prepare without creating an execution
start({ action: "prepare", workflowId: "moira/verified-research", parentExecutionId: "none" })
// → { startAttemptId: "start-1", expiresAt: "..." }

// 2. Execute that exact prepared start
start({ action: "execute", startAttemptId: "start-1" })
// → { processId: "xyz", attemptId: "attempt-1", directive: "...", ... }

// 3. Do work, then advance
step({ processId: "xyz", attemptId: "attempt-1", input: { findings: "..." } })
// → { attemptId: "attempt-2", directive: "next step...", ... }
```

### Resume After Interruption

```json
// 1. Find your execution
session({ action: "executions" })
// → [{ executionId: "xyz", status: "waiting", ... }]

// 2. Get current step
session({ action: "current_step", executionId: "xyz" })
// → { attemptId: "attempt-current", directive: "...", completionCondition: "...", ... }

// 3. Continue
step({ processId: "xyz", attemptId: "attempt-current", input: { ... } })
```

## Validation Errors

If `step()` returns validation error, check:

1. **Field names** - Must match schema exactly (case sensitive)
2. **Required fields** - All required properties must be present
3. **Data types** - String vs number vs boolean must match
4. **Enum values** - Must be one of allowed values

`ATTEMPT_PROCESSING` means another caller still owns this exact mutation; retry the same Process ID,
Step attempt ID, and input, or the same Start attempt ID for `start({ action: "execute" })`.
`ATTEMPT_OUTCOME_UNKNOWN` means an external effect may have happened; inspect the returned Process
ID through `session` and do not automatically retry. The execution owner can retire a blocked
execution with its current revision through
`session({ action: "cancel-execution", executionId, expectedRevision })`.

## Related Documentation

- [MCP Tools Reference](/docs/docs/reference/tools) - Full tool documentation
- [Agent Instructions](/docs/docs/integration/agent-instructions) - System prompt
- [Troubleshooting](/docs/docs/integration/troubleshooting) - Common issues
