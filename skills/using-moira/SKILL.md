---
name: using-moira
description: Use Moira MCP to discover, execute, and resume structured agent workflows. Use when working with Moira or a Moira execution.
---

# Use Moira

Use the connected `moira` MCP server and complete its OAuth flow when prompted.

1. Call `help` with topic `agent-guide` before the first run or whenever lifecycle handling is uncertain. Use `help` with topic `tools` for current schemas rather than relying on remembered tool contracts.
2. Call `list` to discover available workflows and choose the exact current `owner/slug` for the user's task.
3. Start with `start` action `prepare`, then pass the returned `startAttemptId` to `start` action `execute`. Use `parentExecutionId: "none"` for a standalone run.
4. Follow each returned directive and completion condition. Submit work with the current Step attempt ID and the presented input schema; never reuse an attempt from a newer presentation or invent an attempt ID.
5. Perform and verify the actual work. Schema validation checks response structure, not whether the work happened.
6. Use `session` actions `current_step` and `execution_context` to inspect or resume an existing run. After an uncertain outcome, inspect the original execution instead of automatically repeating a mutation.

Keep the execution ID and current Step attempt ID available for continuation. Follow recovery and error-handling instructions returned by the server.
