Start a workflow execution by workflow ID

Usage:

- Provide workflowId to start execution
- Optionally add 'note' to identify this execution (shown in session list)
- Use 'parentExecutionId' to link child workflows ("none" for standalone)
- If Telegram setup is required by notification or lock-delivery pre-flight, the response provides setup guidance without creating an execution or returning a processId
- Otherwise, returns a processId for use with the step() tool

Workflow lifecycle: list() → start(workflowId) → step(processId) → repeat step() until completion

Examples:

- start({ workflowId: "moira/test-planning", parentExecutionId: "none" }) - public workflow
- start({ workflowId: "john/my-workflow", note: "Feature: auth system", parentExecutionId: "none" }) - user's workflow

parentExecutionId errors:

- "Invalid format" → Must be "none" or valid UUID (xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx)
- "Parent execution not found" → Use session({ action: "executions" }) to find valid execution IDs

Next: Complete any returned setup guidance, or use the returned processId with step() to execute workflow steps
