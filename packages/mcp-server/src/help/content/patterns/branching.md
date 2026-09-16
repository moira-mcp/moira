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

### Choice Collection

```json
{
  "type": "agent-directive",
  "id": "get-action",
  "directive": "Ask user: create new or edit existing?",
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
        "left": { "contextPath": "action" },
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
        "left": { "contextPath": "action" },
        "right": "create"
      },
      "output": "create"
    },
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "action" },
        "right": "edit"
      },
      "output": "edit"
    }
  ],
  "connections": {
    "create": "create-branch",
    "edit": "edit-branch",
    "default": "delete-branch"
  }
}
```

:::tip
For multi-way branches, order cases from most to least common for efficiency.
:::

## Branching by Boolean Flag

```json
{
  "type": "condition",
  "id": "check-has-tests",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "has_tests" },
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

```json
{
  "type": "condition",
  "id": "check-error-count",
  "cases": [
    {
      "when": {
        "operator": "gt",
        "left": { "contextPath": "error_count" },
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

```json
{
  "when": {
    "operator": "and",
    "conditions": [
      {
        "operator": "eq",
        "left": { "contextPath": "status" },
        "right": "ready"
      },
      {
        "operator": "gt",
        "left": { "contextPath": "items_count" },
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
