---
title: Branching Pattern
description: Different paths for different scenarios
---

## Purpose

Route workflow execution to different paths based on user choice, collected data, or computed conditions.

## Structure

```
[get-choice] → [route] → choice=A → [path-a] → [merge]
                      → choice=B → [path-b] → [merge]
```

## Implementation

The examples below are node fragments; connection targets must exist in the containing workflow.
Answers remain in their producing node's scope unless declared in the registry and written through
`globalInputs`. Prefer placing `cases` directly on that producer when it owns the decision.

### Choice Collection

```json
{
  "type": "agent-directive",
  "id": "get-action",
  "directive": "Ask user: create new or edit existing?",
  "completionCondition": "The user selected create or edit",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "edit"] }
    },
    "required": ["action"]
  },
  "connections": { "success": "route-action" }
}
```

### Simple Binary Route

```json
{
  "type": "condition",
  "id": "route-action",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "get-action.action" },
        "right": "create"
      },
      "output": "create"
    }
  ],
  "connections": {
    "create": "create-workflow",
    "default": "edit-workflow"
  }
}
```

A binary decision is one case plus `default`: the case names the branch it selects, and
`default` carries every other value.

## Multi-Way Branching

For more than 2 options, list several cases on one condition node. Cases are evaluated in
authored order; the first whose `when` holds selects its output, and `default` catches the rest:

```json
{
  "id": "route-action",
  "type": "condition",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "get-action.action" },
        "right": "create"
      },
      "output": "create"
    },
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "get-action.action" },
        "right": "edit"
      },
      "output": "edit"
    }
  ],
  "connections": {
    "create": "create-branch",
    "edit": "edit-branch",
    "default": "clarify-action"
  }
}
```

:::tip
Case order expresses precedence: overlapping predicates select the first match. Reordering by
frequency can change behavior. An unknown action must not default to a destructive operation.
:::

## Branching by Boolean Flag

Assume `collect-capabilities` returned the string enum `has_tests: "yes" | "no"`; this is not a boolean.

```json
{
  "type": "condition",
  "id": "check-has-tests",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-capabilities.has_tests" },
        "right": "yes"
      },
      "output": "has-tests"
    }
  ],
  "connections": {
    "has-tests": "run-tests",
    "default": "skip-tests"
  }
}
```

## Branching by Numeric Value

Here `validate-result` returns an observed error count; a supplied count alone does not prove quality.

```json
{
  "type": "condition",
  "id": "check-error-count",
  "cases": [
    {
      "when": {
        "operator": "gt",
        "left": { "contextPath": "validate-result.error_count" },
        "right": 0
      },
      "output": "has-errors"
    }
  ],
  "connections": {
    "has-errors": "fix-errors",
    "default": "proceed"
  }
}
```

## Complex Conditions

Combine multiple checks inside a single case:
`prepare-result` and `collect-items` must have produced the referenced values before routing.

```json
{
  "when": {
    "operator": "and",
    "conditions": [
      {
        "operator": "eq",
        "left": { "contextPath": "prepare-result.status" },
        "right": "ready"
      },
      {
        "operator": "gt",
        "left": { "contextPath": "collect-items.items_count" },
        "right": 0
      }
    ]
  },
  "output": "ready"
}
```

## Merging Branches

Branches typically converge at a common node:

```
[create-branch] → [save-workflow]
[edit-branch]   → [save-workflow]
```

Both paths connect to the same target node.

## Related Patterns

- [Information Collection](/docs/patterns/information-collection/) - Collect data for routing decisions
- [Skip Pattern](/docs/patterns/skip/) - Special case of branching for optional steps
