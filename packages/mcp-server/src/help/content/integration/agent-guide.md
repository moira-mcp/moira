---
title: MCP Agent Guide
description: How to use MCP Moira tools and execute workflows
sidebar:
  order: 2
---

This guide explains how AI agents use MCP Moira tools to execute workflows.

## MCP Tools Overview

Workflow and delivery tools include:

| Tool                                    | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `workflow` (`list`)                     | List available workflows                                 |
| `execution` (`prepare`, `execute`)      | Prepare or execute a start                               |
| `execution` (`step`)                    | Advance workflow with input                              |
| `workflow`                              | CRUD operations on workflows                             |
| `execution`                             | User info and execution state                            |
| `settings`                              | User settings                                            |
| `communication` (`send`)                | Text through configured user channels                    |
| `communication` (`deliver`)             | Native attachment through its owner                      |
| `communication` (`deliver_publication`) | Existing immutable owner publication                     |
| `collect` in the originating group      | Inspect an original operation by its returned reference  |
| `find` in the originating group         | Discover original owner operations and choose explicitly |
| `workflow`                              | Upload/download tokens                                   |
| `help`                                  | Documentation                                            |

## Basic Workflow Execution

### 1. Prepare and Start Workflow

```json
execution({ action: "prepare", workflowId: "moira/robust-task", parentExecutionId: "none" })
```

Preparation validates the request and reserves a Start attempt for 15 minutes without creating an
execution or running any workflow node. It returns `startAttemptId` independently of mutable
notification and trusted-lock readiness. Execute that exact attempt to run those preflight checks:

```json
execution({ action: "execute", startAttemptId: "start-attempt-123" })
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
returns the stored result with the current common language instruction and cannot create a second execution. Preparing again is an
intentional request for a separate execution.

### 2. Execute Step

After completing the work described in `directive`:

```json
execution({ action: "step", processId: "abc-123-def",
  attemptId: "attempt-456",
  input: {
    "steps": ["Step 1", "Step 2", "Step 3"]
  }
})
```

Returns next directive or completion status.

### 3. Continue Until Complete

Repeat `execution({ action: "step", processId, attemptId, input })` calls until workflow returns completion.

Use the Step attempt ID from the current presentation for every call, including a step with empty
input. A replay of the same attempt with the same input returns its stored result without advancing
again. Never use an attempt from an older presentation.

Ordinary steps, current-step reads and replay presentations carry the same common instruction:
write all free-form text you author in the user's requested or preferred language, even when the
directive uses another language. Preserve schema keys, identifiers, enum values, code, commands
and exact quotations. Presentation does not rewrite the stored original response, attempt IDs or
fingerprints. Pass objects, arrays, numbers and booleans in their declared types; serialize JSON
only when the particular schema requires text.

## Response Format

Every workflow step returns:

| Field                 | Description                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `processId`           | UUID for this execution, use in all `execution({ action: "step", processId, attemptId, input })` calls |
| `attemptId`           | Identity of this exact presented step                                                                  |
| `directive`           | What to do (the instruction)                                                                           |
| `completionCondition` | When you're done (success criteria)                                                                    |
| `inputSchema`         | How to structure your response (JSON Schema)                                                           |

## Understanding Directives vs Conditions

**directive** = WHAT to do
**completionCondition** = WHEN you're successfully done

Example:

- directive: "Run all project tests"
- completionCondition: "All tests pass (0 failures)"

The agent must:

1. Execute the directive (run tests)
2. Verify the completionCondition is met (check for 0 failures)
3. Only then proceed with `execution({ action: "step", processId, attemptId, input })`

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

Submit one object matching the presented schema, with every required property present. It may contain nested objects or arrays when declared. Response keys must be declared even when additionalProperties is true. Global and node-local fields are already combined in the presented schema; callers do not add a separate scope wrapper. Schema validity does not establish that an external action happened: inspect the evidence before reporting completion.

## Navigation Tools

### List Executions

```json
execution({ action: "executions" })
```

Returns the first page of active executions for the current user with status, workflow ID, and
notes. Use `limit` and `offset` for additional pages.

### Get Current Step

Resume workflow after interruption:

```json
execution({ action: "current_step", executionId: "abc-123" })
```

Returns the current agent-facing step presentation without advancing the workflow, including the
Process ID, Step attempt ID, directive, success criteria, and input schema when present. Applicable child-workflow,
system-reminder, and teleport context is included as well.

### Get Full Context

```json
execution({ action: "execution_context", executionId: "abc-123" })
```

Returns execution state including context variables, history, the workflow-step `revision`, and
independent task-identity, parent, context, and reminder revisions. Supply the matching target revision together
with `expectedRevision` when changing that metadata; successful writes return the next target
revision without changing the step revision.

## Naming the task

At intake, read execution context and persist the actual name before submitting the step:

```javascript
execution({
  action: "update-task-title",
  executionId,
  taskTitle: "Implement authentication",
  expectedRevision: current.revision,
  expectedTaskIdentityRevision: current.metadataRevisions.taskIdentity,
});
```

`current` is the execution-context result. Apply the [task-name contract](/docs/concepts/workflows/#execution-task-name)
for limits, stale guards and no-op behavior. Rename at an authorized actual scope change;
ordinary progress retains the name and the current step attempt. Notes below remain separate.

## Execution Notes

Track execution progress with notes:

```json
execution({ action: "prepare", workflowId: "dev-flow", note: "Feature: auth system", parentExecutionId: "none" })
execution({ action: "execute", startAttemptId: "start-attempt-123" })
```

Update note during execution via `execution({ action: "step", processId, attemptId, input })` input only when that step's schema declares `execution_note`:

```json
execution({ action: "step", processId: "abc-123",
  attemptId: "attempt-456",
  input: {
    "task_result": "done",
    "execution_note": "Step 3: Integration tests"
  }
})
```

Or through the execution tool:

```json
execution({
  action: "update-note",
  executionId: "abc-123",
  note: "Step 3: Integration tests"
})
```

## Waiting for the User

When you cannot continue without the user — a requirement you do not understand, access you lack,
a choice only they can make — raise your question on the run and ask it in the chat as well:

```json
execution({
  action: "await-user",
  executionId: "abc-123",
  question: "Which environment should the release go to?",
  options: ["staging", "production"]
})
```

The run is then shown as waiting for the user, with your question and choices, instead of looking
like it waits for you, and the user is notified through their channels with the question and a link
to the run (a new question within ten minutes of the previous notification waits for its turn). `question` is up to 500 characters and `options` up to four choices. The
user answers you in the chat, not in Moira. A new call replaces the question; your next step, a
variable you set with `set-variable`, or `resolve: true` clears it, and so does the run leaving the
step. The call does not change the step revision, so your current Step attempt stays valid.

## Stopping a Workflow

When the user cancels the run or asks to continue outside it, read its `revision` with
`execution({ action: "execution_context", executionId })`, then stop that owned run:

```json
execution({
  action: "stop-execution",
  executionId: "abc-123",
  expectedRevision: 4,
  reason: "The user cancelled this workflow and asked to continue directly."
})
```

Use the actual returned revision. The reason is required and contains 1–500 characters after
trimming. Stopping permanently ends the run, records `stopReason`, clears its waits and advances
the revision once; it does not certify successful task completion. Do not invent step results to
finish a cancelled workflow. If an execution operation, including recovery or a run-page answer,
is still in progress, stopping is refused:
wait for it to finish and read the context again. A stale revision or an already finished run is
also refused. After a lost response, repeat the original revision and reason to receive the same
stopped result without another change. Stopped runs do not match the default active overview;
use **Stopped** or **All** to find them and choose **All time** for older runs. A stopped ancestor
can remain as labelled context for an eligible child. Their active child runs continue independently.
The web UI's owner stop controls use the same guarded operation. Read `stopCapability` as an advisory
snapshot; the stored mutation repeats ownership, revision and executing-operation checks.

## Finding Workflows

### List the First Page

```json
workflow({ action: "list" })
```

### Search by Name

```json
workflow({ action: "list", search: "test" })
```

### Filter by Visibility

```json
workflow({ action: "list", visibility: "public", limit: 10 })
```

## Reading and changing definitions

For `list`, `total` counts the whole filtered query. Follow the returned `nextOffset` rather than
inferring the next page from its length; `nextOffset: null` ends the listing. Filters apply together.

`workflow` (`get`) returns metadata, variable registry, runtime policy, progress and reminder definitions
as well as structure. `includeNodes: false` omits only node definitions; `includeValidation: false`
omits only validation results. Use `list-nodes`, `get-nodes` or `analyze-variables` for a focused read.
Mutations validate the complete resulting graph before saving; a rejected mutation is not partly
applied. Moving a node changes array order, not its connections. Cloning requires an existing source
and an unused target ID. Node search supports bounded RE2-compatible expressions and falls back to
case-insensitive literal matching for invalid or unsupported patterns. Visibility, access grants
and invites require the appropriate owner authority.

Reconciliation compares the previous bundled definition, current database definition and incoming
image definition. Status is available to agents; full candidates and resolution require an
administrator. Resolve semantic conflicts through Workflow Management Flow, not mechanical JSON merging.

## Settings

Read one exact `key`, one `category`, or all accessible settings; do not combine key and category.
`list` returns currently available definitions, not stored values. Definitions come from the database
and installed extension manifests. Administrator-only definitions and values remain hidden from
other users. Database secrets return `[encrypted]`; extension secrets return a dotted mask with
the last four characters. A mask is not a value to write back.

Writing requires an existing definition and obeys its type, JSON Schema and built-in numeric bounds,
administrator restrictions and encryption policy. Saving a Telegram bot token registers its webhook.
Structured JSON must survive serialization and reading without data loss or coercion. Extension
defaults pass the same type/schema checks before a manifest is accepted. Removing an extension
hides its definitions but retains user values for reinstallation.

For workflow JSON import/export use `workflow` actions `upload` and `download` for short-lived
grants; upload uses multipart field `workflow`. Ordinary definition reads and mutations use the
other `workflow` actions.

## Common Patterns

### Start and Execute First Step

```json
// 1. Prepare without creating an execution
execution({ action: "prepare", workflowId: "moira/verified-research", parentExecutionId: "none" })
// → { startAttemptId: "start-1", expiresAt: "..." }

// 2. Execute that exact prepared start
execution({ action: "execute", startAttemptId: "start-1" })
// → { processId: "xyz", attemptId: "attempt-1", directive: "...", ... }

// 3. Do work, then advance
execution({ action: "step", processId: "xyz", attemptId: "attempt-1", input: { findings: "..." } })
// → { attemptId: "attempt-2", directive: "next step...", ... }
```

### Resume After Interruption

```json
// 1. Find your execution
execution({ action: "executions" })
// → a page of active executions; choose the exact original Process ID

// 2. Get current step
execution({ action: "current_step", executionId: "xyz" })
// → { attemptId: "attempt-current", directive: "...", completionCondition: "...", ... }

// 3. Continue
execution({ action: "step", processId: "xyz", attemptId: "attempt-current", input: { ... } })
```

## Validation Errors

If `execution({ action: "step", processId, attemptId, input })` returns validation error, check:

1. **Field names** - Must match schema exactly (case sensitive)
2. **Required fields** - All required properties must be present
3. **Data types** - String vs number vs boolean must match
4. **Enum values** - Must be one of allowed values

`ATTEMPT_PROCESSING` means another caller still owns this exact mutation; retry the same Process ID,
Step attempt ID, and input, or the same Start attempt ID for `execution({ action: "execute" })`.
`ATTEMPT_STALE` was rejected before handler work. Automatically read
`execution({ action: "current_step", executionId })` and reconcile its node, directive, schema and
current intent before submitting with the returned Step attempt ID. Do not carry old input into
another step or overwrite a newer user answer.
`ATTEMPT_CONFLICT` means the attempt is already bound to different input. Automatically read
`execution({ action: "current_step", executionId })`, discard the conflicting attempt, and continue
from the returned directive and input schema without replaying the rejected input; user guidance is
not required unless the current directive requires a decision.
For a step-level `ATTEMPT_INVALID_OR_EXPIRED` that explicitly directs you to `current_step`, use the
same state-refresh recovery and do not reuse the unavailable attempt. An unavailable start attempt
does not provide this recovery.
`ATTEMPT_OUTCOME_UNKNOWN` means an external effect may have happened; inspect the returned Process
ID through `execution` and do not automatically retry. The execution owner can retire a blocked
execution with its current revision through
`execution({ action: "cancel-execution", executionId, expectedRevision })`.

A write made on a revision that is no longer current — a reminder, parent, context or cancellation
whose `expectedRevision` or target revision is older than the stored one, or a message that says
"reload" or "is stale" — is rejected before anything is written. Re-read that state (`reminders`,
`variables`, `execution_context`, or the workflow for a workflow revision). Reconcile the intended
change with the new state before using its revisions; stale guards do not authorize replacing concurrent work.

When an error carries an `AGENT INSTRUCTIONS` section, follow it. It tells you to stop only where a
person is needed: missing permission, an authentication or connection problem you cannot resolve, a
workflow that does not exist, or an effect that may already have happened. Any other error — an
invalid input, a missing execution, an error with no specific instructions — is yours to resolve:
diagnose it with `help`, `execution` (`diagnose`, `current_step`, `execution_context`) and `workflow` (`list`),
fix what lies within your task, and ask the user only for a decision, permission, credential or fact
you cannot obtain yourself.

## Related Documentation

- [MCP Tools Reference](/docs/reference/tools/) - Full tool documentation
- [Agent Instructions](/docs/integration/agent-instructions/) - System prompt
- [Troubleshooting](/docs/integration/troubleshooting/) - Common issues
