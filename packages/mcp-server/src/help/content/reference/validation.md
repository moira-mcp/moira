---
title: Validation System
description: How Moira validates workflows and agent responses
---

# Validation System

Moira performs comprehensive validation at multiple levels to ensure workflow integrity and correct agent responses.

## Validation Levels

### 1. JSON Schema Validation

Workflows are validated against a JSON Schema definition:

- Structure validation against workflow schema
- Required field checking (id, metadata, nodes)
- Type validation for all properties
- Built-in node schema branches and the namespaced extension-node form

### 2. Structural Validation

Graph structure is analyzed for correctness:

- **Node connectivity** - All connections point to valid nodes
- **Required nodes** - Start node must exist
- **Circular dependencies** - Loops are detected and flagged
- **Unreachable nodes** - Nodes no entry point leads to. Entry points are the start node and every `teleport`: a teleport has no ordinary incoming connections, so whatever it routes to is reachable through `step({ teleportTo })` and is not reported
- **Registry entries** - Each `variableRegistry` entry must be a valid JSON Schema (a malformed `items`/`pattern`/etc. is a blocking error) with a non-empty description
- **Materialize declarations** - Every entry has exactly one source (`from` or empty `content`),
  registry sources are string defaults, declared paths are safe and unique, and all connection
  targets exist
- **Process blocks** - When `progress` is present, every node declares `progressNodeId` for an
  existing block, every block has `content.summary`, every connection leaving a block or returning
  carries a `connectionLabels` entry (returns with `cycle.cause` and `cycle.exit`), and each
  `{{progress_*_outcome}}` template sits on one block that owns a writer; each violation is an
  error with a stable code (`unowned-node`, `unknown-block`, `empty-block`, `empty-description`,
  `unlabeled-edge`, `unexplained-cycle`, `outcome-duplicate`, `outcome-unowned`,
  `unconnected-block`)
- **Routing cases** - Each case of a `condition` or `agent-directive` node is checked as described
  under _Routing Diagnostics_ below
- **Extension node types** - Types found in the live extension registry or a published registry
  snapshot validate their declared configuration schema. A live registry that does not contain a
  type reports an error; a type absent from a snapshot, or validation without usable registry data,
  produces an unresolved warning instead

### 3. Input Validation

Agent responses are validated against `inputSchema`:

- AJV-based JSON Schema validation
- Type checking for response fields
- Required field validation
- Pattern and format validation

## Schema Version and Migration

`metadata.schemaVersion` is an integer that describes the shape of the definition itself, beside the
semver `metadata.version` that describes its content. The current value is `1`; a definition without
the field is version 0.

Every definition is upgraded to the current version before it is checked, so validation never sees
an older shape. The upgrade runs wherever a definition enters the system — validation, upload
through the API, MCP or the CLI, the bundled catalog, and stored definitions read back — and once at
startup for stored definitions, reconciliation baselines and recorded conflicts. It is pure and
idempotent: a definition already at the current version comes back unchanged.

Authors never have to migrate by hand. To rewrite a file on disk into the current shape, run:

```bash
moira-workflow <file> migrate
```

Like every write, it creates a backup first. Run a second time it reports
«Already at schema version 1; nothing to migrate».

## Routing Diagnostics

A `condition` or `agent-directive` node routes through ordered `cases`, each naming a key of the
node's `connections`. The validator checks them as follows. The identifier in parentheses is the
code that appears in the message.

| Severity | Condition                                                                         |
| -------- | --------------------------------------------------------------------------------- |
| error    | A case names an output that is not a key of `connections` (`unknown-case-output`) |
| error    | A case names a reserved control output (`error` or `timeout`)                     |
| error    | A `condition` node has no `cases`, or no `connections.default`                    |
| warning  | A case selects the node's own default output, which makes the case redundant      |
| warning  | An authored output no case names can never be taken (`unreachable-output`)        |

`unreachable-output` is a warning rather than an error because a definition is edited one step at a
time and a connection is often added before the case that selects it; the definition stays valid.
The default output (`default` on a condition node, `success` on an agent-directive node) and the
control outputs `error` and `timeout` need no case of their own.

Each case's `when` gets the same operator and structure checks as any structured condition, and the
declared-variable check below applies to the paths it reads. `expressions` on a routing node get the
same syntax and registry checks as a standalone `expression` node.

## Validation Results

Validation returns structured results:

```typescript
{
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}
```

### Error Types

| Type         | Description             | Example                     |
| ------------ | ----------------------- | --------------------------- |
| `schema`     | JSON structure invalid  | Missing required field      |
| `structure`  | Graph structure invalid | Orphan node                 |
| `connection` | Connection invalid      | Points to non-existent node |
| `reference`  | Reference invalid       | Invalid subgraph ID         |

### Warning Types

| Type          | Description        | Threshold                 |
| ------------- | ------------------ | ------------------------- |
| `performance` | Large workflow     | >20 agent-directive nodes |
| `complexity`  | Complex conditions | Deeply nested conditions  |
| `context`     | Large context      | >100KB context size       |

## Validation Examples

### Valid Workflow

```json
{
  "id": "valid-workflow",
  "metadata": {
    "name": "Valid Workflow",
    "version": "1.0.0",
    "description": "A valid workflow"
  },
  "nodes": [
    { "id": "start", "type": "start", "connections": { "default": "task" } },
    {
      "id": "task",
      "type": "agent-directive",
      "directive": "...",
      "completionCondition": "...",
      "connections": { "success": "end" }
    },
    { "id": "end", "type": "end" }
  ]
}
```

Result:

```json
{ "valid": true, "errors": [], "warnings": [] }
```

### Invalid Workflow - Missing Connection

```json
{
  "nodes": [
    { "id": "start", "type": "start", "connections": { "default": "missing" } },
    { "id": "end", "type": "end" }
  ]
}
```

Result:

```json
{
  "valid": false,
  "errors": [
    {
      "type": "connection",
      "message": "Node 'start' references non-existent node 'missing'",
      "nodeId": "start"
    }
  ]
}
```

### Workflow with Warning

Large workflow triggers performance warning:

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "type": "performance",
      "message": "Workflow has 25 agent-directive nodes. Consider breaking into subgraphs.",
      "count": 25
    }
  ]
}
```

## Input Schema Validation

Agent responses are validated against `inputSchema` defined on agent-directive nodes.

### Nodes Without inputSchema

Nodes without `inputSchema` require empty input from agent. Non-empty responses are rejected:

```json
// Node without inputSchema
{ "id": "task", "type": "agent-directive", "directive": "..." }

// Valid: empty response
{}

// Invalid: non-empty response
{ "result": "done" }  // Rejected with validation error
```

### Schema Definition

```json
{
  "type": "agent-directive",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" },
      "confidence": { "type": "number", "minimum": 0, "maximum": 10 }
    },
    "required": ["result"]
  }
}
```

### Valid Response

```json
{ "result": "completed", "confidence": 8 }
```

### Invalid Response

```json
{ "confidence": "high" }
```

Error:

```json
{
  "valid": false,
  "errors": [
    { "field": "result", "message": "Required field missing" },
    { "field": "confidence", "message": "Expected number, got string" }
  ]
}
```

## Declared-But-No-Default Variable Warning

The validator emits a `warning` (severity `warning`, not an error — the workflow is still valid) when a `variableRegistry` variable is referenced in a `directive`, `completionCondition`, `message`, or a routing case's `when`, but the variable has no `default` and is never written by any upstream node's `globalInputs` (and is not present in the start node's `initialData`).

At runtime, such a reference renders the literal placeholder `[[UNDEFINED_VARIABLE]]` instead of a value.

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "type": "structure",
      "severity": "warning",
      "nodeId": "do-work",
      "message": "Variable 'iteration' is referenced in node 'do-work' but has no default and is never written by an upstream node. It will render [[UNDEFINED_VARIABLE]] at runtime."
    }
  ]
}
```

Fix it one of two ways:

- Add a `default` to the variable in `variableRegistry`.
- Have an upstream node write the variable via its `globalInputs` before the node that references it.

## Playbook Reference Validation

A definition that names a playbook with `{{playbook:name}}` is accepted only when the author can
read that playbook: their own, or another account's published one. An unreadable reference is a
blocking error wherever a definition is written — the `manage` tool refuses to create or edit, and a
definition saved through the API is stored as invalid — and the message names the playbook and the
three ways out: create it, publish it, or remove the reference.

The same rule runs once more when a run is started, because a playbook can disappear between the
last edit and the start. `start` refuses before the execution exists rather than presenting a step
whose behaviour text is missing.

A reference written with a leading backslash (`\{{playbook:name}}`) is literal text and is not
checked — that is how a document can explain the syntax without naming a playbook.

## Injection Safety

Substituted variable and data VALUES are never re-executed as templates. When the engine interpolates a value into a `directive` or `message`, that value is treated as a literal string — brace syntax originating from substituted data is neutralized and not re-parsed.

This means templates only ever execute in author-controlled static node fields, not in values that arrive from agent input or external data.

Playbook content follows the same boundary. Your own playbook is author-controlled text and is
processed like the rest of your definition; a playbook belonging to another account is neutralized
before substitution, so published text cannot execute templates inside your run.

:::danger
Do not echo untrusted input containing `{{...}}` into a directive. Declare the variables you need
and reference them explicitly. Prefer explicit named variables over `{{context.variables}}`
full-dumps, which can expose the entire variable bag.
:::

## Materialize Validation

A `materialize` node is accepted only when `basePath` is non-empty, `files` contains 1–100 entries,
and `connections.success` is present. Every declared `files[].path` must be a normalized relative
path without NUL, absolute roots, backslash roots, empty segments, `.`, or `..`; declared paths must
be unique. Each entry declares exactly one of:

- `from`: the name of a `variableRegistry` entry with `type: "string"` and a string `default`;
- `content: ""`: an empty skeleton file. Non-empty inline content is rejected.

Because paths can contain templates, the same safety and collision checks run again after
rendering against the current execution context. Runtime rendering additionally enforces 1 MiB per
file and 10 MiB total uncompressed content. A failure while preparing the step routes through the
optional `connections.error`; otherwise it is raised. Every HTTP download revalidates the
five-minute grant and its user/execution/node binding; repeats are accepted only while the bound
execution remains waiting on that node. Context delivery revalidates the same bindings and adds one
further bound: a set over 256 KiB in total is refused rather than truncated.

## Best Practices

1. **Always include inputSchema** - Validate agent responses for consistent data
2. **Keep workflows focused** - Split large workflows into subgraphs
3. **Test validation** - Use `manage` with `includeValidation: true`
4. **Handle errors gracefully** - Define error connections for validation failures
