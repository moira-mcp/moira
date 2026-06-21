Execute the next step in a workflow process

Usage:

- Provide processId from start() or previous step()
- Provide 'input' matching the step's inputSchema (if required)
- Returns next directive, completionCondition, and inputSchema
- Continue calling step() until workflow completes

Workflow lifecycle: list() → start(workflowId) → step(processId) → repeat step() until completion

Examples:

- step({ processId: "abc123" }) - for steps without required input
- step({ processId: "abc123", input: { decision: "yes" } }) - with input

Teleport (jump to a different workflow branch):

- step({ processId: "abc123", teleportTo: "node-id" }) - jump to a teleport node
- Only teleport-type nodes can be targets
- When teleporting, do NOT provide input — the teleport node will present its own directive

Related: Use session({ action: "current_step", executionId }) to resume interrupted workflow
