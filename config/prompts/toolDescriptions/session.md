Inspect and update current-user and execution-scoped state

Actions:

- user: Get current user information
- executions: List workflow executions, including active or completed states, with filters
- execution_context: Get full context of specific execution
- current_step: Get current step directive (for resuming after interruption)
- progress: Get the current read-only user-facing progress graph projection
- progress-image-token: Mint a short-lived one-time PNG download URL for owned execution progress

`progress-image-token` accepts optional `theme` (`light|dark`) and `viewportWidth` (480-4096). It
returns `downloadUrl`, `expiresAt`, `mimeType`, and `executionRevision` metadata, never binary image
content. The URL is revision/version-bound and single-use after a successful response.

- update-note: Update execution note
- set-parent: Attach, replace, or detach (`parentExecutionId: "none"`) a same-owner running parent; requires expectedRevision
- add-reminder: Add a bounded execution reminder with optional idempotencyKey
- reminders: List execution reminders with optional status/search filters
- update-reminder: Update one active reminder by ID
- remove-reminder: Cancel one reminder by ID without deleting audit history
- variables: Query declared runtime variables with names/search/types/hasValue/editable/writePhase filters
- set-variable: Set one explicitly policy-allowed declared variable at an allowed paused node

execution_context vs current_step:

- execution_context: Current execution metadata, variables, node states, errors, and active-lock context for inspection and debugging; it is not a complete step input/output transcript
- current_step: Resume a running workflow from its current agent-facing step presentation. The response includes the Process ID, directive, success criteria, and input schema when present, plus applicable active-child, system-reminder, and teleport context.

Examples:

- session({ action: "user" })
- session({ action: "executions", status: ["waiting", "running"] })
- session({ action: "current_step", executionId: "abc123" })
- session({ action: "update-note", executionId: "abc123", note: "New context" })
- session({ action: "set-parent", executionId: "child-id", parentExecutionId: "parent-id", expectedRevision: 2 })
- session({ action: "add-reminder", executionId: "abc123", reminderText: "Open the PR", idempotencyKey: "delivery-pr", expectedRevision: 2 })
