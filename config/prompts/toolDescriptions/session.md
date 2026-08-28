Get current user info, active executions, or execution context

Actions:

- user: Get current user information
- executions: List workflow executions (with filters)
- execution_context: Get full context of specific execution
- current_step: Get current step directive (for resuming after interruption)
- update-note: Update execution note
- set-parent: Attach, replace, or detach (`parentExecutionId: "none"`) a same-owner running parent; requires expectedRevision
- add-reminder: Add a bounded execution reminder with optional idempotencyKey
- reminders: List execution reminders with optional status/search filters
- update-reminder: Update one active reminder by ID
- remove-reminder: Cancel one reminder by ID without deleting audit history
- variables: Query declared runtime variables with names/search/types/hasValue/editable/writePhase filters
- set-variable: Set one explicitly policy-allowed declared variable at an allowed paused node

execution_context vs current_step:

- execution_context: FULL execution history - all steps, inputs, outputs (for analysis, debugging)
- current_step: ONLY current directive and inputSchema (for resuming workflow after interruption)

Examples:

- session({ action: "user" })
- session({ action: "executions", status: ["waiting", "running"] })
- session({ action: "current_step", executionId: "abc123" })
- session({ action: "update-note", executionId: "abc123", note: "New context" })
- session({ action: "set-parent", executionId: "child-id", parentExecutionId: "parent-id", expectedRevision: 2 })
- session({ action: "add-reminder", executionId: "abc123", reminderText: "Open the PR", idempotencyKey: "delivery-pr", expectedRevision: 2 })
