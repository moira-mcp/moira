---
title: MCP Agent Guide
description: How to use MCP Moira tools and execute workflows
sidebar:
  order: 2
---

This guide explains how AI agents use MCP Moira tools to execute workflows.

## MCP Tools Overview

MCP Moira exposes these tools:

| Tool       | Purpose                       |
| ---------- | ----------------------------- |
| `list`     | List available workflows      |
| `start`    | Start workflow execution      |
| `step`     | Advance workflow with input   |
| `manage`   | CRUD operations on workflows  |
| `session`  | User info and execution state |
| `settings` | User settings                 |
| `token`    | Upload/download tokens        |
| `help`     | Documentation                 |

## Basic Workflow Execution

### 1. Start Workflow

```json
start({ workflowId: "moira/robust-task", parentExecutionId: "none" })
```

When Telegram pre-flight setup is not required, the response contains:

```json
{
  "processId": "abc-123-def",
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

If the workflow requires Telegram setup, `start` returns setup guidance without creating an
execution or returning a `processId`. Complete that guidance and call `start` again.

### 2. Execute Step

After completing the work described in `directive`:

```json
step({
  processId: "abc-123-def",
  input: {
    "steps": ["Step 1", "Step 2", "Step 3"]
  }
})
```

Returns next directive or completion status.

### 3. Continue Until Complete

Repeat `step()` calls until workflow returns completion.

## Response Format

Every workflow step returns:

| Field                 | Description                                        |
| --------------------- | -------------------------------------------------- |
| `processId`           | UUID for this execution, use in all `step()` calls |
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
Process ID, directive, success criteria, and input schema when present. Applicable child-workflow,
system-reminder, and teleport context is included as well.

### Get Full Context

```json
session({ action: "execution_context", executionId: "abc-123" })
```

Returns execution state including context variables and history.

## Execution Notes

Track execution progress with notes:

```json
start({ workflowId: "dev-flow", note: "Feature: auth system", parentExecutionId: "none" })
```

Update note during execution via `step()` input:

```json
step({
  processId: "abc-123",
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
// 1. Start
start({ workflowId: "moira/verified-research", parentExecutionId: "none" })
// → { processId: "xyz", directive: "...", ... }

// 2. Do work, then advance
step({ processId: "xyz", input: { findings: "..." } })
// → { directive: "next step...", ... }
```

### Resume After Interruption

```json
// 1. Find your execution
session({ action: "executions" })
// → [{ executionId: "xyz", status: "waiting", ... }]

// 2. Get current step
session({ action: "current_step", executionId: "xyz" })
// → { directive: "...", completionCondition: "...", ... }

// 3. Continue
step({ processId: "xyz", input: { ... } })
```

## Validation Errors

If `step()` returns validation error, check:

1. **Field names** - Must match schema exactly (case sensitive)
2. **Required fields** - All required properties must be present
3. **Data types** - String vs number vs boolean must match
4. **Enum values** - Must be one of allowed values

## Related Documentation

- [MCP Tools Reference](/docs/docs/reference/tools) - Full tool documentation
- [Agent Instructions](/docs/docs/integration/agent-instructions) - System prompt
- [Troubleshooting](/docs/docs/integration/troubleshooting) - Common issues
