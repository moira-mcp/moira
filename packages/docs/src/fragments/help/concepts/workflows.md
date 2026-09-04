A workflow in Moira is a directed graph of nodes that defines a multi-step process for AI agents to execute.

## Workflow Structure

### Static execution progress

A workflow may declare an optional top-level `progress` graph for a concise user-facing view. Its
definition may include a template-enabled title, goal, bounded generic facts, and ordered nodes.
Nodes contain `id`, template-enabled `label`, optional structured plain-text `content` (`summary`,
`details`, `outcome`, and `next`), and an optional static `connections.default` used for drawing.
User-visible waiting nodes in the primary graph select a milestone with
`progressNodeId`.

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

Progress array order defines state: milestones before the active one are completed, the active one
is current, and later ones are pending. Returning to an earlier milestone through repair, a loop, or
replan automatically reopens it. Connections never route execution, and progress has no variables,
conditions, stored status, history, or cursor.

When `progress` is present, every user-visible waiting node (`agent-directive`, `teleport`, `lock`,
`materialize`, and `subgraph`) must map to an existing milestone. Multiple primary nodes may map to
one milestone. The currently active primary node is the focus target for its milestone; other
milestones focus their first mapped primary node in workflow order. A completed execution shows all
milestones through its last persisted mapped waiting node as complete and leaves later milestones
pending. Completion after a final mapped responsibility therefore completes every milestone, while
any terminal with an earlier mapped frontier leaves later milestones pending. Older completion
records without a usable mapped frontier retain the all-completed fallback. Pending milestones keep
summary, details, and next guidance but hide `outcome`, so an older revision or unit result cannot
appear current during an engine-owned transition.

The engine exposes one shared content-rich visual model and a bounded light/dark PNG renderer. The
model keeps the complete task, goal, facts, completed outcomes, current activity, details and next
action visible without hover. Text wraps without truncation and milestones pack into deterministic
left-to-right rows when one row does not fit.
Agents request a short-lived, revision-bound, single-use download URL through `session
progress-image-token`; the binary does not pass through MCP. A `telegram-notification` node may set
`attachProgressImage: true` and use its normal message as the photo caption. Such a node must map to
an existing progress milestone.

Engine integrations with a workflow and execution use `renderExecutionProgressImage(...)`. It
returns `null` when progress is absent, otherwise the PNG buffer, MIME type, dimensions, workflow
version, and execution revision; rendering failures stay errors.

On execution pages this same model appears above the technical graph and detail tabs. Actionable
milestones can focus their mapped technical node; unmapped milestones remain readable non-controls.
The visible card and PNG contain the same essential information. Workflows without progress keep the
standard inspector unchanged.

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

1. Engine creates an execution instance with unique `processId`
2. Finds the start node (type: `start`)
3. Returns the first directive to the agent
4. Agent executes and returns result
5. Engine evaluates connections and moves to next node
6. Repeat until reaching an end node (type: `end`)

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

Common node types are shown below. This table is representative, not exhaustive; see
[Nodes](/docs/concepts/nodes/) for every supported type and its current contract.

| Type                    | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `start`                 | Entry point for workflow execution                 |
| `end`                   | Terminal node marking completion                   |
| `agent-directive`       | Agent task with directive and completion condition |
| `condition`             | Branch based on structured conditions              |
| `expression`            | Compute values using arithmetic expressions        |
| `subgraph`              | Delegate to another workflow                       |
| `telegram-notification` | Send notifications via Telegram                    |

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
