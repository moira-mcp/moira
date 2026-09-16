---
title: Condition Operators
description: Reference for all condition operators in workflow nodes
---

A structured condition is the object that decides whether a routing case holds. It appears as the
`when` of a case on a `condition` or `agent-directive` node:

```json
{
  "id": "check-status",
  "type": "condition",
  "cases": [
    {
      "when": { "operator": "eq", "left": { "contextPath": "status" }, "right": "ready" },
      "output": "ready"
    }
  ],
  "connections": { "ready": "next-step", "default": "wait" }
}
```

Every example below shows the condition object itself — what you place in a case's `when`.

## Comparison Operators

### Equal (`eq`)

```json
{
  "operator": "eq",
  "left": { "contextPath": "status" },
  "right": "ready"
}
```

Works with strings, numbers, booleans.

### Not Equal (`neq`)

```json
{
  "operator": "neq",
  "left": { "contextPath": "error_count" },
  "right": 0
}
```

### Greater Than (`gt`)

```json
{
  "operator": "gt",
  "left": { "contextPath": "score" },
  "right": 80
}
```

### Greater Than or Equal (`gte`)

```json
{
  "operator": "gte",
  "left": { "contextPath": "items_count" },
  "right": 1
}
```

### Less Than (`lt`)

```json
{
  "operator": "lt",
  "left": { "contextPath": "retry_count" },
  "right": 3
}
```

### Less Than or Equal (`lte`)

```json
{
  "operator": "lte",
  "left": { "contextPath": "error_rate" },
  "right": 0.05
}
```

## String Operators

### Contains (`contains`)

```json
{
  "operator": "contains",
  "left": { "contextPath": "message" },
  "right": "error"
}
```

Also works with arrays:

```json
{
  "operator": "contains",
  "left": { "contextPath": "tags" },
  "right": "urgent"
}
```

## Existence Operators

### Exists (`exists`)

```json
{
  "operator": "exists",
  "value": { "contextPath": "optional_field" }
}
```

Returns true if variable exists and is not null/undefined.

## Logical Operators

### AND (`and`)

All conditions must be true:

```json
{
  "operator": "and",
  "conditions": [
    {
      "operator": "eq",
      "left": { "contextPath": "status" },
      "right": "complete"
    },
    {
      "operator": "gt",
      "left": { "contextPath": "score" },
      "right": 80
    }
  ]
}
```

### OR (`or`)

At least one condition must be true:

```json
{
  "operator": "or",
  "conditions": [
    {
      "operator": "eq",
      "left": { "contextPath": "priority" },
      "right": "high"
    },
    {
      "operator": "eq",
      "left": { "contextPath": "priority" },
      "right": "critical"
    }
  ]
}
```

### NOT (`not`)

Negates a condition:

```json
{
  "operator": "not",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "status" },
    "right": "blocked"
  }
}
```

## Context Path Syntax

### Simple Path

```json
{ "contextPath": "variable_name" }
```

### Nested Path

```json
{ "contextPath": "user.profile.name" }
```

### Array Index

```json
{ "contextPath": "items[0]" }
```

### Combined

```json
{ "contextPath": "results[0].score" }
```

## Literal Values

Right-hand values can be literals:

```json
{
  "right": "string value"
}
```

```json
{
  "right": 42
}
```

```json
{
  "right": true
}
```

```json
{
  "right": null
}
```

:::note
When comparing with `contextPath` on both sides, both values are resolved from context before
comparison.
:::

## Common Patterns

### Check Boolean Flag

```json
{
  "operator": "eq",
  "left": { "contextPath": "has_tests" },
  "right": "yes"
}
```

### Check Iteration Limit

```json
{
  "operator": "lt",
  "left": { "contextPath": "current_iteration" },
  "right": 5
}
```

### Route Three Outcomes

One case per authored output; the first case that holds wins, and `default` covers the rest:

```json
{
  "id": "route-verdict",
  "type": "condition",
  "cases": [
    {
      "when": { "operator": "eq", "left": { "contextPath": "verdict" }, "right": "blocked" },
      "output": "blocked"
    },
    {
      "when": { "operator": "eq", "left": { "contextPath": "verdict" }, "right": "minor" },
      "output": "minor"
    }
  ],
  "connections": {
    "blocked": "escalate",
    "minor": "fix-issues",
    "default": "proceed"
  }
}
```

## See Also

- [Workflow Templates](/docs/reference/workflow-templates/) - Using conditions in workflows
- [Validation](/docs/reference/validation/) - Input validation rules
