---
title: Workflows
description: Understanding Moira workflow structure and execution
---

A workflow in Moira is a directed graph of nodes that defines a multi-step process for AI agents to execute.

## Workflow Structure

### Static execution progress

A workflow may declare an optional top-level `progress` graph for a concise user-facing view. Its
definition may include a template-enabled title, goal, bounded generic facts, and ordered nodes.
Nodes contain `id`, template-enabled `label`, optional structured plain-text `content` (`summary`,
`details`, `outcome`, and `next`), and an optional static `connections.default` used for drawing.

The progress graph is the workflow's process view: its nodes are **blocks**, and their array order
is the process order. When `progress` is present, every node of the primary graph — routing nodes
included — declares the block it belongs to through `progressNodeId`; every block carries a
description in `content.summary`; and every connection that leaves a block, or returns to an
earlier block or to its own block, carries a `connectionLabels` entry keyed like `connections`:
a plain label, or `{ "label": …, "cycle": { "cause": …, "exit": … } }` for a return. Transitions,
loops and hub blocks are derived from the primary graph and never authored twice; the display-only
`connections.default` is ignored by that derivation. An outcome template (`{{progress_*_outcome}}`)
sits on exactly one block, which owns a node that writes the variable. Validation reports every
violation as an error with a stable code — `unowned-node`, `unknown-block`, `empty-block`,
`empty-description`, `unlabeled-edge`, `unexplained-cycle`, `outcome-duplicate`,
`outcome-unowned` — and `moira-workflow <file> derive` or `GET /api/workflows/:id/process` shows
the derived blocks with the same diagnostics.

A waiting node may also declare template-enabled `progressActiveLabel`. It replaces the displayed
label only while that exact primary node is current, letting a workflow show truthful unit,
iteration, validation, or repair detail without changing stable inactive milestone labels. It
requires a valid mapping and never affects routing or stored state.

The execution note is projected as the task title. A waiting node may declare
`progressActiveContent` with the same structured fields. Its fields replace matching milestone
content only while that exact node is current; omitted fields keep their stable base values. Nested
strings use the normal variable registry and template protection. Progress stores no presentation
history, so replacing revision-bound context replaces the next projection instead of retaining
stale values from an earlier plan.
Resolved text is checked against the same bounds after interpolation. Oversized runtime data fails
the projection explicitly rather than being silently truncated into a misleading summary.

Block status comes from the execution's recorded route, never from block order. Every execution
records one visit per node it runs — the node, the connection it left through (`teleport` for a
jump), the variables it changed, and whether it paused — and `session({ action: "progress" })`
projects that route onto the process: the block of the last visit is `active`, or `waiting` when
the run pauses there; a visited block is `done`, or `repeated` with the number of passes through
its working steps; a block whose work never ran or that the run bypassed is `skipped`; the rest
are `pending`. Returning to an earlier block through repair, a loop, or replan makes it active
again and counts another pass. Nothing unvisited is ever reported done, and an execution created
before routes were recorded reports only its current block as active with `routeRecorded: false`.
The same projection lists the route with loop markers and every variable with its history;
values set from outside the flow appear as adjustments with their actor. Connections never route
execution.

When `progress` is present, every primary node maps to an existing block, as described above.
Multiple primary nodes may map to one block. The currently active primary node is the focus target
for its block; other blocks focus their first mapped primary node in workflow order. Pending and
skipped blocks keep summary, details, and next guidance but hide `outcome`, so an older revision
or unit result cannot appear current during an engine-owned transition.

The engine exposes one shared content-rich visual model and a bounded light/dark PNG renderer. The
model keeps the complete task, goal, facts, completed outcomes, current activity, details and next
action visible without hover. Text wraps without truncation and milestones pack into deterministic
left-to-right rows when one row does not fit.
Agents request a short-lived, revision-bound, single-use download URL through `session
progress-image-token`; the binary does not pass through MCP. A `user-notification` node may set
`attachProgressImage: true` and use its normal message as the image caption. Such a node must map to
an existing progress milestone. The deprecated `telegram-notification` compatibility node supports
the same attachment for existing provider-specific workflows.

Engine integrations with a workflow and execution use `renderExecutionProgressImage(...)`. It
returns `null` when progress is absent, otherwise the PNG buffer, MIME type, dimensions, workflow
version, and execution revision; rendering failures stay errors.

The flow page (see the _Reading and editing a flow_ guide) shows the derived process of the
definition itself and lets its owner edit it in place. On the run page (see the _Reading a run_
guide) the same projection is shown as lanes, a canvas,
an outline and the route, with a block panel that drills into each block's steps and focuses the
technical node graph. The page and the PNG contain the same essential information. A workflow
without progress shows the technical node graph and the context tabs instead.

Every workflow consists of:

```json
{
  "id": "my-workflow",
  "metadata": {
    "name": "My Workflow",
    "version": "1.0.0",
    "description": "Description of what this workflow does"
  },
  "variableRegistry": {
    "project_name": { "type": "string", "description": "Name of the project" }
  },
  "nodes": [
    // Array of node definitions
  ]
}
```

### Metadata

| Field         | Required | Description                    |
| ------------- | -------- | ------------------------------ |
| `name`        | Yes      | Human-readable workflow name   |
| `version`     | Yes      | Semantic version string        |
| `description` | Yes      | What the workflow accomplishes |

### Variable Registry

`variableRegistry` declares the workflow's global variables once — the single source of truth for each variable's type and description. Each entry is keyed by variable name:

| Field         | Required | Description                                         |
| ------------- | -------- | --------------------------------------------------- |
| `type`        | Yes      | `string`, `number`, `boolean`, `object`, or `array` |
| `description` | Yes      | What the variable holds                             |
| `default`     | No       | Initial value seeded at workflow start              |

Globals are referenced by bare name (`{{project_name}}`); a node writes a global by listing its name in `inputSchema.globalInputs`.

### Nodes Array

Nodes are the steps in your workflow. Each node has an `id` and a `type` that determines its behavior.

## Workflow Execution

When a workflow starts:

1. Engine creates an execution instance with a unique `processId`
2. Finds the start node (type: `start`)
3. Returns the first directive and its server-issued Step attempt ID
4. Agent executes and submits the result with that Process ID and Step attempt ID
5. Engine atomically records the transition, exact response receipt, and next attempt
6. Repeat until reaching an end node (type: `end`)

Repeating the same attempt with the same input returns its stored response without advancing again.
Each later paused presentation has a different attempt ID.

## Execution Context

Each execution maintains a context object containing:

```typescript
{
  variables: Record<string, unknown>; // Globals at variables[name]; node-local outputs at variables[nodeId]
  nodeStates: Record<string, unknown>; // Per-node state
  executionId: string; // Unique execution ID
  workflowId: string; // Source workflow ID
  currentNodeId: string; // Current position
}
```

Global variables (declared in `variableRegistry`) live at `variables[name]` and resolve by bare name (`{{name}}`). A node's outputs live at `variables[nodeId]` and resolve as `{{node-id.name}}`.

:::tip
Variables persist across steps. Globals carry workflow-wide values; node outputs carry per-step
results.
:::

## Node Types

Common built-in node types are shown below. This table is representative, not exhaustive; see
[Nodes](/docs/concepts/nodes/) for the built-in types and their current contracts. Installed
extensions may add namespaced node types; their current title, origin, version, and configuration
schema come from the installation's node-type catalog.

| Type                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `start`                 | Entry point for workflow execution                    |
| `end`                   | Terminal node marking completion                      |
| `agent-directive`       | Agent task with directive and completion condition    |
| `condition`             | Branch based on structured conditions                 |
| `expression`            | Compute values using arithmetic expressions           |
| `subgraph`              | Delegate to another workflow                          |
| `user-notification`     | Notify through the current user's configured channels |
| `telegram-notification` | Deprecated Telegram-only compatibility node           |

## Connections

Nodes connect via the `connections` object that defines the flow. Each node type has specific connection types:

### Agent Directive Node

```json
{
  "id": "analyze-task",
  "type": "agent-directive",
  "directive": "Analyze the task requirements",
  "completionCondition": "Analysis is complete",
  "connections": {
    "success": "next-step",
    "error": "error-handler"
  }
}
```

### Condition Node

```json
{
  "id": "check-status",
  "type": "condition",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "status" },
    "right": "success"
  },
  "connections": {
    "true": "success-path",
    "false": "retry-path"
  }
}
```

## Complete Workflow Example

```json
{
  "id": "simple-workflow",
  "metadata": {
    "name": "Simple Task Workflow",
    "version": "1.0.0",
    "description": "A basic workflow demonstrating node connections"
  },
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "connections": { "default": "main-task" }
    },
    {
      "id": "main-task",
      "type": "agent-directive",
      "directive": "Complete the assigned task",
      "completionCondition": "Task is completed successfully",
      "connections": { "success": "end" }
    },
    {
      "id": "end",
      "type": "end"
    }
  ]
}
```

## Workflow Visibility

Workflows have visibility settings:

- **private** - Only the owner can access
- **public** - All users can start the workflow

## Best Practices

1. **Start with start** - Every workflow must have a start node
2. **End with end** - Use end nodes to mark completion
3. **Clear Directives** - Write unambiguous instructions
4. **Measurable Conditions** - Completion conditions should be verifiable
5. **Error Handling** - Include error connections for graceful failures
6. **Documentation** - Add descriptions to complex nodes

## Related

- [Nodes](/docs/concepts/nodes/) - Node types and configuration
- [Templates](/docs/concepts/templates/) - Dynamic content in workflows
