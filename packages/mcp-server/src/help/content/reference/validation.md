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
- Enum validation for node types

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

### 3. Input Validation

Agent responses are validated against `inputSchema`:

- AJV-based JSON Schema validation
- Type checking for response fields
- Required field validation
- Pattern and format validation

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

The validator emits a `warning` (severity `warning`, not an error — the workflow is still valid) when a `variableRegistry` variable is referenced in a `directive`, `completionCondition`, `message`, or `condition`, but the variable has no `default` and is never written by any upstream node's `globalInputs` (and is not present in the start node's `initialData`).

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

## Injection Safety

Substituted variable and data VALUES are never re-executed as templates. When the engine interpolates a value into a `directive` or `message`, that value is treated as a literal string — brace syntax originating from substituted data is neutralized and not re-parsed.

This means templates only ever execute in author-controlled static node fields, not in values that arrive from agent input or external data.

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
optional `connections.error`; otherwise it is raised. The HTTP download validates the one-use,
five-minute grant and its user/execution/node binding before rendering any content.

## Best Practices

1. **Always include inputSchema** - Validate agent responses for consistent data
2. **Keep workflows focused** - Split large workflows into subgraphs
3. **Test validation** - Use `manage` with `includeValidation: true`
4. **Handle errors gracefully** - Define error connections for validation failures
