Get current user info, active executions, or execution context

Actions:

- user: Get current user information
- executions: List workflow executions (with filters)
- execution_context: Get full context of specific execution
- current_step: Get current step directive (for resuming after interruption)
- update-note: Update execution note

execution_context vs current_step:

- execution_context: FULL execution history - all steps, inputs, outputs (for analysis, debugging)
- current_step: ONLY current directive and inputSchema (for resuming workflow after interruption)

Examples:

- session({ action: "user" })
- session({ action: "executions", status: ["waiting", "running"] })
- session({ action: "current_step", executionId: "abc123" })
- session({ action: "update-note", executionId: "abc123", note: "New context" })
