---
description: "Restore the original Moira execution and continue its current step"
---

# Resume workflow

Use an execution ID already known from the task or `$ARGUMENTS`. Otherwise inspect the task's
locally ignored `agent_temp_files_local/moira-ws/` workspace for its `process-id.txt`, then use
`session` with `action: "executions"` to reconcile available runs if necessary. Compare task and
repository context before choosing; ask when several candidates remain genuinely ambiguous.
An absent local file or one missing list page is not proof that the original run disappeared.

Call `session` with `action: "current_step"` and the original `executionId`. Inspect
`execution_context` when saved variables, ownership, status or pending effects matter. Use the
current returned `attemptId`; do not submit an old archived presentation or infer that completed
work should be repeated. Verify existing artifacts against the current completion condition and
finish only the missing work before calling `step` with the presented schema.

For an unavailable or stale attempt, refresh the current presentation as directed. For a genuinely
blocked execution, use the [diagnosis and recovery contract](../docs/reference/execution.md#diagnosis-and-recovery).
Do not recover a healthy run, invent missing persisted state, replay an unknown external mutation
or replace an errored run with another start. A completed or stopped execution stays terminal.
Report unresolved access or original-outcome uncertainty without pretending it was resolved.

Read the [Agent Guide](../packages/mcp-server/src/help/content/integration/agent-guide.md) for
start/step receipt rules. Use the configured client's actual `session` and `step` tools rather
than guessing a host-specific prefix. Preserve the selected identity and its existing workspace.
